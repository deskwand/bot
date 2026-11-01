import type { TSchema, Static } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { TaskEventBody } from "../protocol";

export type ApprovalDecision = "approved" | "rejected" | "expired";

/** Longest argument summary sent to the channel. */
const ARGS_SUMMARY_LIMIT = 200;

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
  ): Promise<ApprovalDecision>;
  resolve(
    approvalId: string,
    decision: "approved" | "rejected",
  ): { ok: boolean; message: string };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
        created_at INTEGER NOT NULL
      )`,
    );
  }

  async request(
    tool: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    const id = this.nextId();
    const argsJson = JSON.stringify(args ?? null) ?? "null";
    this.sql.exec(
      `INSERT INTO approvals (id, tool, args_json, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`,
      id,
      tool,
      argsJson,
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
        argsSummary: argsJson.slice(0, ARGS_SUMMARY_LIMIT),
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

  resolve(
    approvalId: string,
    decision: "approved" | "rejected",
  ): { ok: boolean; message: string } {
    const status = this.statusOf(approvalId);
    if (status !== "pending") {
      return { ok: false, message: "该审批已处理或已失效" };
    }

    const waiter = this.waiters.get(approvalId);
    if (!waiter) {
      // Pending in storage but nobody is waiting: the task object restarted
      // while the tool was waiting, and pi interrupted that generation.
      this.setStatus(approvalId, "expired");
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

/**
 * Run `tool` only after the user approves its arguments. A refusal (or a
 * timeout) is reported to the model as an ordinary tool result so it can
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
      const decision = await gate.request(tool.name, args, signal ?? NEVER_ABORTED);
      if (decision === "approved") return tool.execute(args, api, context);

      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }

      return {
        output: [
          {
            type: "text",
            text: `用户拒绝了此操作（${decision}），请换一种方式或直接向用户说明`,
          },
        ],
      };
    },
  };
}
