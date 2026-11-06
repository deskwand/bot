import type { TSchema, Static } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { TaskEventBody } from "../protocol";
import { REVIEW_FAILED_REASON, type ReviewVerdict } from "./review";

export type ApprovalDecision = "approved" | "rejected" | "expired";

/** Optional context for an approval request, shown to the owner and the reviewer. */
export type ApprovalNote = {
  description?: string;
  reason?: string;
  /** Unredacted-enough arguments for the reviewer; never sent to the inner gate. */
  reviewArgs?: unknown;
};

export const PROPOSE_RULES_TOOL = "propose_rules";

/** Longest argument summary sent to the channel. */
const ARGS_SUMMARY_LIMIT = 200;

/** Longest reason shown on a proposed rules card. */
const REASON_SUMMARY_LIMIT = 300;

/** Used by wrappers when the tool context carries no abort signal. */
const NEVER_ABORTED = new AbortController().signal;

type Waiter = {
  settle: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
};

/** What {@link withApproval} needs from a gate; tests can fake it. */
export interface ApprovalGateLike {
  request(
    tool: string,
    args: unknown,
    signal: AbortSignal,
    note?: ApprovalNote,
  ): Promise<ApprovalDecision>;
  resolve(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<{ ok: boolean; message: string }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Card text for one approval. A proposed rules change shows its reason and the
 * full new text; other tools keep the bounded JSON snippet.
 */
export function approvalSummary(tool: string, argsJson: string): string {
  if (tool === PROPOSE_RULES_TOOL) {
    let args: unknown;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return argsJson.slice(0, ARGS_SUMMARY_LIMIT);
    }
    if (typeof args === "object" && args !== null) {
      const { content, reason } = args as {
        content?: unknown;
        reason?: unknown;
      };
      if (typeof content === "string") {
        const text = typeof reason === "string" ? reason : "";
        const summary =
          text.length > REASON_SUMMARY_LIMIT
            ? `${text.slice(0, REASON_SUMMARY_LIMIT)}…`
            : text;
        const rules = content.trim();
        return `理由：${summary}\n新守则：\n${rules.length > 0 ? rules : "（清空守则）"}`;
      }
    }
  }
  return argsJson.slice(0, ARGS_SUMMARY_LIMIT);
}

/**
 * Durable permission gate for side-effecting tools.
 *
 * `request()` records the pending approval, reports it, and waits in memory
 * for a decision made through the Telegram buttons (or for the timeout). The
 * waiter is in-memory by design: after a restart the record is stale and
 * `resolve()` marks it expired instead of waking a tool that no longer runs.
 */
export class ApprovalGate implements ApprovalGateLike {
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly sql: SqlStorage,
    private readonly emit: (body: TaskEventBody) => Promise<void>,
    private readonly timeoutMs = 600_000,
  ) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      )`,
    );
    // Tasks created before reasons existed keep their rows; old rows read NULL.
    const columns = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(approvals)`)
      .toArray();
    if (!columns.some((column) => column.name === "reason")) {
      this.sql.exec(`ALTER TABLE approvals ADD COLUMN reason TEXT`);
    }
  }

  async request(
    tool: string,
    args: unknown,
    signal: AbortSignal,
    note?: ApprovalNote,
  ): Promise<ApprovalDecision> {
    const id = this.nextId();
    const argsJson = JSON.stringify(args ?? null) ?? "null";
    this.sql.exec(
      `INSERT INTO approvals (id, tool, args_json, status, reason, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
      id,
      tool,
      argsJson,
      note?.reason ?? null,
      Date.now(),
    );

    // The waiter is registered before the event is reported so a decision
    // that arrives while the outbox is writing still reaches this call.
    const pending = new Promise<ApprovalDecision>((resolve) => {
      const onAbort = () => this.settle(id, "rejected");
      const timer = setTimeout(() => this.settle(id, "expired"), this.timeoutMs);
      this.waiters.set(id, {
        settle: resolve,
        timer,
        signal,
        onAbort,
      });
      if (signal.aborted) {
        this.settle(id, "rejected");
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    try {
      await this.emit({
        type: "approval_requested",
        approvalId: id,
        tool,
        argsSummary: approvalSummary(tool, argsJson),
        ...(note?.reason !== undefined ? { reason: note.reason } : {}),
      });
    } catch (error) {
      // The approval row is durable; it expires on its own if the channel
      // never learns about it.
      console.warn(
        `approval ${id} requested emit failed: ${errorMessage(error)}`,
      );
    }

    const decision = await pending;
    await this.emitResolved(id, decision);
    return decision;
  }

  /**
   * Pending approvals that are still actionable on this instance: persisted
   * rows alone are not enough, because a restart loses the waiting tool call.
   */
  pending(): {
    approvalId: string;
    tool: string;
    argsSummary: string;
    reason?: string;
  }[] {
    const now = Date.now();
    return this.sql
      .exec<{
        id: string;
        tool: string;
        args_json: string;
        reason: string | null;
        created_at: number;
      }>(
        `SELECT id, tool, args_json, reason, created_at FROM approvals
         WHERE status = 'pending' ORDER BY created_at ASC, id ASC`,
      )
      .toArray()
      .filter((row) => {
        const waiter = this.waiters.get(row.id);
        return (
          waiter !== undefined &&
          !waiter.signal.aborted &&
          row.created_at + this.timeoutMs > now
        );
      })
      .map((row) => ({
        approvalId: row.id,
        tool: row.tool,
        argsSummary: approvalSummary(row.tool, row.args_json),
        ...(row.reason !== null ? { reason: row.reason } : {}),
      }));
  }

  async resolve(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<{ ok: boolean; message: string }> {
    const status = this.statusOf(approvalId);
    if (status !== "pending") {
      return { ok: false, message: "该审批已处理或已失效" };
    }

    const waiter = this.waiters.get(approvalId);
    if (!waiter) {
      // Pending in storage but nobody is waiting: the task object restarted
      // while the tool was waiting, and pi interrupted that generation. Close
      // the approval message so its buttons do not stay live.
      this.setStatus(approvalId, "expired");
      await this.emitResolved(approvalId, "expired");
      return { ok: false, message: "该审批已失效" };
    }

    this.settle(approvalId, decision);
    return {
      ok: true,
      message: decision === "approved" ? "已批准" : "已拒绝",
    };
  }

  private settle(approvalId: string, decision: ApprovalDecision): void {
    const waiter = this.waiters.get(approvalId);
    if (!waiter) return;
    // The row is the source of truth: a timeout and a button press can race.
    if (this.statusOf(approvalId) !== "pending") return;

    this.setStatus(approvalId, decision);
    this.waiters.delete(approvalId);
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.settle(decision);
  }

  private async emitResolved(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    try {
      await this.emit({
        type: "approval_resolved",
        approvalId,
        decision,
      });
    } catch (error) {
      console.warn(
        `approval ${approvalId} resolved emit failed: ${errorMessage(error)}`,
      );
    }
  }

  private nextId(): string {
    const row = this.sql
      .exec<{ next: number }>(
        `SELECT COALESCE(MAX(CAST(SUBSTR(id, 3) AS INTEGER)), 0) + 1 AS next
         FROM approvals`,
      )
      .toArray()[0];
    return `ap${row?.next ?? 1}`;
  }

  private statusOf(approvalId: string): string | undefined {
    return this.sql
      .exec<{ status: string }>(
        `SELECT status FROM approvals WHERE id = ?`,
        approvalId,
      )
      .toArray()[0]?.status;
  }

  private setStatus(approvalId: string, status: ApprovalDecision): void {
    this.sql.exec(
      `UPDATE approvals SET status = ? WHERE id = ?`,
      status,
      approvalId,
    );
  }
}

/** Shared refusal text for approval-gated tools. */
export function rejectionText(decision: ApprovalDecision): string {
  return `用户拒绝了此操作（${decision}），请换一种方式或直接向用户说明`;
}

/**
 * Gate that never asks the owner. It is used for write actions in the
 * autonomous approval mode; an already-aborted call is still refused so an
 * interrupted task cannot start a new tool.
 */
export class AutoGate implements ApprovalGateLike {
  async request(
    _tool: string,
    _args: unknown,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    return signal.aborted ? "rejected" : "approved";
  }

  async resolve(
    _approvalId: string,
    _decision: "approved" | "rejected",
  ): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: "该审批已处理或已失效" };
  }
}

/** One booked review, kept for troubleshooting. */
export type ReviewRow = {
  tool: string;
  argsSummary: string;
  verdict: "allow" | "ask";
  reason: string;
  failed: boolean;
};

/**
 * Reviews write actions before asking the owner.
 *
 * In-scope actions are reported and run; risky or failed reviews fall through
 * to the durable {@link ApprovalGate}, which shows the review's reason.
 */
export class ReviewedGate implements ApprovalGateLike {
  constructor(
    private readonly inner: ApprovalGateLike,
    private readonly sql: SqlStorage,
    private readonly review: (
      tool: string,
      args: unknown,
      description: string,
      signal: AbortSignal,
    ) => Promise<ReviewVerdict>,
    private readonly emitProgress: (text: string) => Promise<void>,
  ) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool TEXT NOT NULL,
        args_summary TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reason TEXT NOT NULL,
        failed INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
  }

  async request(
    tool: string,
    args: unknown,
    signal: AbortSignal,
    note?: ApprovalNote,
  ): Promise<ApprovalDecision> {
    if (signal.aborted) return "rejected";

    let verdict: ReviewVerdict;
    try {
      verdict = await this.review(
        tool,
        note?.reviewArgs ?? args,
        note?.description ?? "",
        signal,
      );
    } catch (error) {
      // The task was interrupted while reviewing; do not ask the owner for a
      // call that no longer runs.
      if (signal.aborted) return "rejected";
      // Any other failure must not block the tool or slip it through: ask.
      console.warn(`review for ${tool} failed: ${errorMessage(error)}`);
      verdict = { verdict: "ask", reason: REVIEW_FAILED_REASON, failed: true };
    }
    if (signal.aborted) return "rejected";

    this.record({
      tool,
      argsSummary: (JSON.stringify(args ?? null) ?? "null").slice(
        0,
        ARGS_SUMMARY_LIMIT,
      ),
      verdict: verdict.verdict,
      reason: verdict.reason,
      failed: verdict.failed,
    });

    if (verdict.verdict === "allow") {
      try {
        await this.emitProgress(`✔️ 自动放行 ${tool}：${verdict.reason}`);
      } catch (error) {
        console.warn(
          `review progress for ${tool} failed: ${errorMessage(error)}`,
        );
      }
      return "approved";
    }

    return this.inner.request(tool, args, signal, {
      description: note?.description,
      reason: verdict.reason,
    });
  }

  resolve(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<{ ok: boolean; message: string }> {
    return this.inner.resolve(approvalId, decision);
  }

  private record(row: ReviewRow): void {
    try {
      this.sql.exec(
        `INSERT INTO reviews (tool, args_summary, verdict, reason, failed, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        row.tool,
        row.argsSummary,
        row.verdict,
        row.reason,
        row.failed ? 1 : 0,
        Date.now(),
      );
    } catch (error) {
      console.warn(`review record for ${row.tool} failed: ${errorMessage(error)}`);
    }
  }
}

/**
 * Run `tool` only after the user approves its arguments. A refusal (or a
 * timeout) is reported as an error result so scripts can catch it and the model can
 * choose another approach; an aborted run rethrows so pi sees an interruption.
 */
export function withApproval<T extends TSchema>(
  tool: ToolRegistration<T>,
  gate: ApprovalGateLike,
): ToolRegistration<T> {
  return {
    ...tool,
    async execute(args: Static<T>, api, context) {
      const signal = context.abortSignal;
      const decision = await gate.request(tool.name, args, signal ?? NEVER_ABORTED, {
        description: tool.description,
      });
      if (decision === "approved") return tool.execute(args, api, context);

      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }

      return {
        isError: true,
        output: [
          {
            type: "text",
            text: rejectionText(decision),
          },
        ],
      };
    },
  };
}
