import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type {
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import {
  ApprovalGate,
  approvalSummary,
  PROPOSE_RULES_TOOL,
  withApproval,
} from "../../src/task/approvals";
import type { ActionEvent, TaskEventBody, TaskSpec } from "../../src/protocol";
import { withProgress } from "../../src/tools/wrap";
import { setModelOverride } from "../../src/llm/models";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const NoArgs = Type.Object({});

function taskStub(taskId: string) {
  return env.TASK.get(env.TASK.idFromName(taskId));
}

type TaskStub = ReturnType<typeof taskStub>;

function sqlOf(instance: unknown): SqlStorage {
  return (instance as unknown as { db: SqlStorage }).db;
}

function pendingId(sql: SqlStorage): string | undefined {
  return sql
    .exec<{ id: string }>(
      `SELECT id FROM approvals WHERE status = 'pending' ORDER BY rowid DESC LIMIT 1`,
    )
    .toArray()[0]?.id;
}

/** A wrapped tool reports progress first, so its row appears asynchronously. */
async function waitForPendingId(sql: SqlStorage): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const id = pendingId(sql);
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("no pending approval");
}

function statusOf(sql: SqlStorage, id: string): string | undefined {
  return sql
    .exec<{ status: string }>(`SELECT status FROM approvals WHERE id = ?`, id)
    .toArray()[0]?.status;
}

/** Runs `fn` against a fresh gate installed on a task object's SQLite storage. */
async function withGate<T>(
  taskId: string,
  fn: (gate: ApprovalGate, sql: SqlStorage, events: TaskEventBody[]) => Promise<T>,
  timeoutMs = 50,
): Promise<T> {
  const stub = taskStub(taskId);
  return runInDurableObject(stub, (instance) => {
    const sql = sqlOf(instance);
    const events: TaskEventBody[] = [];
    const gate = new ApprovalGate(
      sql,
      async (body) => {
        events.push(body);
      },
      timeoutMs,
    );
    return fn(gate, sql, events);
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function context(abortSignal?: AbortSignal): Context {
  return { abortSignal } as unknown as Context;
}

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

function countingTool(counter: { calls: number }): ToolRegistration<typeof NoArgs> {
  return {
    name: "create_page",
    description: "Create a page",
    parameters: NoArgs,
    async execute() {
      counter.calls += 1;
      return { output: [{ type: "text", text: "created" }] };
    },
  };
}

beforeEach(() => {
  setChannelOverride("telegram", fakeChannel().adapter);
});

afterEach(() => {
  setModelOverride(null);
  setChannelOverride("telegram", null);
  vi.restoreAllMocks();
});

describe("ApprovalGate.pending", () => {
  it("lists a live, unexpired waiter with a bounded argument summary", async () => {
    await withGate("t-pending-live", async (gate) => {
      const decision = gate.request(
        "create_page",
        { title: "x".repeat(400) },
        new AbortController().signal,
      );

      await vi.waitFor(() => expect(gate.pending()).toHaveLength(1));
      const [pending] = gate.pending();
      expect(pending).toMatchObject({
        approvalId: "ap1",
        tool: "create_page",
      });
      expect(pending?.argsSummary.length).toBe(200);

      await gate.resolve("ap1", "approved");
      await decision;
      expect(gate.pending()).toEqual([]);
    }, 5000);
  });

  it("does not revive a pending row that has no waiter", async () => {
    await withGate("t-pending-orphan", async (gate, sql) => {
      sql.exec(
        `INSERT INTO approvals (id, tool, args_json, status, created_at)
         VALUES ('ap9', 'create_page', '{}', 'pending', ?)`,
        Date.now(),
      );

      expect(gate.pending()).toEqual([]);
    }, 5000);
  });

  it("does not list a request after its timeout", async () => {
    await withGate("t-pending-timeout", async (gate) => {
      const decision = gate.request(
        "create_page",
        null,
        new AbortController().signal,
      );
      await vi.waitFor(() => expect(gate.pending()).toHaveLength(1));

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(gate.pending()).toEqual([]);
      await decision;
    }, 10);
  });

  it("does not list a request whose waiter was aborted", async () => {
    await withGate("t-pending-aborted", async (gate) => {
      const controller = new AbortController();
      const decision = gate.request("create_page", null, controller.signal);
      await vi.waitFor(() => expect(gate.pending()).toHaveLength(1));

      controller.abort();
      expect(gate.pending()).toEqual([]);
      await decision;
    }, 5000);
  });
});

describe("ApprovalGate", () => {
  it("resolves an approved request and reports both events in order", async () => {
    const outcome = await withGate("t-approve", async (gate, sql, events) => {
      const pending = gate.request(
        "notion__create_page",
        { title: "Hello", body: "x".repeat(500) },
        new AbortController().signal,
      );
      const id = await waitForPendingId(sql);
      // Let the request register its waiter and emit `approval_requested`.
      await tick();
      const resolved = await gate.resolve(id, "approved");
      const decision = await pending;
      return { id, decision, resolved, events: [...events] };
    });

    expect(outcome.decision).toBe("approved");
    expect(outcome.resolved).toEqual({ ok: true, message: "已批准" });
    expect(outcome.events.map((event) => event.type)).toEqual([
      "approval_requested",
      "approval_resolved",
    ]);
    expect(outcome.events[0]).toMatchObject({
      approvalId: outcome.id,
      tool: "notion__create_page",
    });
    const requested = outcome.events[0] as Extract<
      TaskEventBody,
      { type: "approval_requested" }
    >;
    expect(requested.argsSummary).toHaveLength(200);
    expect(outcome.events[1]).toMatchObject({
      approvalId: outcome.id,
      decision: "approved",
    });
  });

  it("returns rejection text from the wrapped tool without executing it", async () => {
    const outcome = await withGate("t-reject", async (gate, sql) => {
      const counter = { calls: 0 };
      const wrapped = withApproval(countingTool(counter), gate);
      const pending = wrapped.execute(
        {},
        {} as never,
        context(new AbortController().signal),
      );
      const id = await waitForPendingId(sql);
      await tick();
      await gate.resolve(id, "rejected");
      const result = await pending;
      return {
        text: textOf(result),
        isError: result.isError,
        calls: counter.calls,
        status: statusOf(sql, id),
      };
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("用户拒绝");
    expect(outcome.text).toContain("rejected");
    expect(outcome.calls).toBe(0);
    expect(outcome.status).toBe("rejected");
  });

  it("executes the tool after approval", async () => {
    await withGate("t-approve-run", async (gate, sql) => {
      const counter = { calls: 0 };
      const wrapped = withApproval(countingTool(counter), gate);
      const pending = wrapped.execute(
        {},
        {} as never,
        context(new AbortController().signal),
      );
      const id = await waitForPendingId(sql);
      await tick();
      await gate.resolve(id, "approved");
      const result = await pending;
      expect(textOf(result)).toBe("created");
      expect(counter.calls).toBe(1);
    });
  });

  it("expires a request nobody answers", async () => {
    const outcome = await withGate("t-expire", async (gate, sql, events) => {
      const decision = await gate.request(
        "notion__create_page",
        {},
        new AbortController().signal,
      );
      const row = sql
        .exec<{ id: string; status: string }>(`SELECT id, status FROM approvals`)
        .toArray()[0];
      return { decision, row, events: [...events] };
    });

    expect(outcome.decision).toBe("expired");
    expect(outcome.row?.status).toBe("expired");
    expect(outcome.events.map((event) => event.type)).toEqual([
      "approval_requested",
      "approval_resolved",
    ]);
    expect(outcome.events[1]).toMatchObject({ decision: "expired" });
  });

  it("treats an abort while waiting as rejected", async () => {
    const outcome = await withGate("t-abort", async (gate, sql, events) => {
      const controller = new AbortController();
      const pending = gate.request(
        "notion__create_page",
        {},
        controller.signal,
      );
      const id = await waitForPendingId(sql);
      await tick();
      controller.abort();
      const decision = await pending;
      return { decision, status: statusOf(sql, id), events: [...events] };
    });

    expect(outcome.decision).toBe("rejected");
    expect(outcome.status).toBe("rejected");
    expect(outcome.events[1]).toMatchObject({ decision: "rejected" });
  });

  it("rethrows from the wrapper when the abort signal fired", async () => {
    await withGate("t-abort-throw", async (gate, sql) => {
      const controller = new AbortController();
      const wrapped = withApproval(countingTool({ calls: 0 }), gate);
      const pending = wrapped.execute({}, {} as never, context(controller.signal));
      const id = await waitForPendingId(sql);
      await tick();
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(statusOf(sql, id)).toBe("rejected");
    });
  });

  it("rejects a second decision for the same approval", async () => {
    const outcome = await withGate("t-double", async (gate, sql) => {
      const counter = { calls: 0 };
      const wrapped = withApproval(countingTool(counter), gate);
      const pending = wrapped.execute(
        {},
        {} as never,
        context(new AbortController().signal),
      );
      const id = await waitForPendingId(sql);
      await tick();
      const first = await gate.resolve(id, "approved");
      await pending;
      const second = await gate.resolve(id, "approved");
      return { first, second, calls: counter.calls };
    });

    expect(outcome.first.ok).toBe(true);
    expect(outcome.second).toEqual({
      ok: false,
      message: "该审批已处理或已失效",
    });
    expect(outcome.calls).toBe(1);
  });

  it("expires a pending row left behind by a restart", async () => {
    const outcome = await withGate("t-restart", async (gate, sql, events) => {
      const now = Date.now();
      sql.exec(
        `INSERT INTO approvals (id, tool, args_json, status, created_at)
         VALUES ('ap9', 'notion__create_page', '{}', 'pending', ?)`,
        now,
      );
      const resolved = await gate.resolve("ap9", "approved");
      return { resolved, status: statusOf(sql, "ap9"), events: [...events] };
    });

    expect(outcome.resolved).toEqual({ ok: false, message: "该审批已失效" });
    expect(outcome.status).toBe("expired");
    expect(outcome.events).toEqual([
      { type: "approval_resolved", approvalId: "ap9", decision: "expired" },
    ]);
  });

  it("shows progress before asking for approval", async () => {
    const outcome = await withGate("t-progress", async (gate, sql, events) => {
      const emit: (body: TaskEventBody) => Promise<void> = async (body) => {
        events.push(body);
      };
      const wrapped = withProgress(
        withApproval(countingTool({ calls: 0 }), gate),
        emit,
        () => "创建页面",
      );
      const pending = wrapped.execute(
        {},
        {} as never,
        context(new AbortController().signal),
      );
      const id = await waitForPendingId(sql);
      await tick();
      await gate.resolve(id, "approved");
      await pending;
      return events.map((event) => event.type);
    });

    expect(outcome).toEqual([
      "progress",
      "approval_requested",
      "approval_resolved",
      "progress",
    ]);
  });
});

describe("TaskDO approvals", () => {
  it("approves a wrapped tool call through handleAction", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "approved_write", args: {} }] },
        { text: "finished" },
      ]),
    );
    const taskId = "t-do-approve";
    const stub = taskStub(taskId);
    await installApprovalTool(stub);

    await stub.start(spec(taskId));

    const approvalId = await waitForApproval(taskId);
    const message = await stub.handleAction(actionEvent(taskId, "approve", approvalId));
    expect(message).toBe("已批准");

    await vi.waitFor(
      async () => {
        expect((await stub.status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    expect(await executedCalls(stub)).toBe(1);
    const events = await butler().debugEvents(taskId);
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "approval_requested",
      "approval_resolved",
      "completed",
    ]);
    expect(events[2]?.payload).toMatchObject({
      approvalId,
      decision: "approved",
    });
  });

  it("rejects through handleAction without running the tool", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "approved_write", args: {} }] },
        { text: "finished" },
      ]),
    );
    const taskId = "t-do-reject";
    const stub = taskStub(taskId);
    await installApprovalTool(stub);

    await stub.start(spec(taskId));

    const approvalId = await waitForApproval(taskId);
    const message = await stub.handleAction(actionEvent(taskId, "reject", approvalId));
    expect(message).toBe("已拒绝");

    await vi.waitFor(
      async () => {
        expect((await stub.status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    expect(await executedCalls(stub)).toBe(0);
    const events = await butler().debugEvents(taskId);
    expect(events[2]?.payload).toMatchObject({
      approvalId,
      decision: "rejected",
    });
  });

  it("reports a stale approval as invalid", async () => {
    const taskId = "t-do-stale";
    const stub = taskStub(taskId);
    await runInDurableObject(stub, (instance) => {
      const sql = sqlOf(instance);
      sql.exec(
        `INSERT INTO approvals (id, tool, args_json, status, created_at)
         VALUES ('ap7', 'notion__create_page', '{}', 'pending', ?)`,
        Date.now(),
      );
    });

    const message = await stub.handleAction(actionEvent(taskId, "approve", "ap7"));
    expect(message).toBe("该审批已失效");
  });
});

function spec(taskId: string): TaskSpec {
  return { taskId, title: `Task ${taskId}`, instructions: "do the thing" };
}

function actionEvent(
  taskId: string,
  action: "approve" | "reject",
  approvalId: string,
): ActionEvent {
  return {
    type: "action",
    channel: "telegram",
    chatId: "1",
    userId: "1",
    actionId: "callback",
    messageId: "message",
    action,
    taskId,
    approvalId,
    eventId: "tg:1",
  };
}

function butler() {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

type ApprovalToolControl = { executed: number };

function approvalControl(instance: unknown): ApprovalToolControl | undefined {
  return (instance as { approvalControl?: ApprovalToolControl })
    .approvalControl;
}

async function installApprovalTool(stub: TaskStub): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const control: ApprovalToolControl = { executed: 0 };
    (instance as { approvalControl?: ApprovalToolControl }).approvalControl =
      control;
    const gate = (instance as unknown as { approvals: ApprovalGate }).approvals;
    const tool: ToolRegistration<typeof NoArgs> = {
      name: "approved_write",
      description: "A side-effecting tool that needs approval.",
      parameters: NoArgs,
      async execute() {
        control.executed += 1;
        return { output: [{ type: "text", text: "wrote" }] };
      },
    };
    instance.registry.install({
      name: "test-approval",
      tools: [withApproval(tool, gate)],
    });
  });
}

async function executedCalls(stub: TaskStub): Promise<number> {
  return runInDurableObject(
    stub,
    (instance) => approvalControl(instance)?.executed ?? 0,
  );
}

async function waitForApproval(taskId: string): Promise<string> {
  let approvalId: string | undefined;
  await vi.waitFor(
    async () => {
      const events = await butler().debugEvents(taskId);
      const requested = events.find(
        (event) => event.type === "approval_requested",
      );
      expect(requested, JSON.stringify(events.map((e) => e.type))).toBeDefined();
      approvalId = (
        requested?.payload as Extract<
          TaskEventBody,
          { type: "approval_requested" }
        >
      ).approvalId;
    },
    { timeout: 10_000 },
  );
  return approvalId!;
}

describe("rules approval card", () => {
  it("shows the full new rules and reason in the event and pending list", async () => {
    const content = "x".repeat(2000);
    const outcome = await withGate(
      "t-rules-card",
      async (gate, _sql, events) => {
        const decision = gate.request(
          PROPOSE_RULES_TOOL,
          { content, reason: "踩坑" },
          new AbortController().signal,
        );
        await vi.waitFor(() => expect(gate.pending()).toHaveLength(1));
        const [pending] = gate.pending();
        await gate.resolve(pending!.approvalId, "approved");
        await decision;
        return { pending, events: [...events] };
      },
      5000,
    );

    const requested = outcome.events.find(
      (event) => event.type === "approval_requested",
    );
    const expectedPrefix = "理由：踩坑\n新守则：\n";
    expect(outcome.pending?.argsSummary.startsWith(expectedPrefix)).toBe(true);
    expect(outcome.pending?.argsSummary).toContain(content);
    expect(requested).toMatchObject({
      tool: PROPOSE_RULES_TOOL,
      argsSummary: outcome.pending?.argsSummary,
    });
  });

  it("trims leading whitespace from proposed rules", () => {
    const summary = approvalSummary(
      PROPOSE_RULES_TOOL,
      JSON.stringify({
        content: "\n".repeat(3000) + "x".repeat(2000),
        reason: "r".repeat(400),
      }),
    );

    expect(summary.length).toBeLessThanOrEqual(4000);
    expect(summary.endsWith("x".repeat(2000))).toBe(true);
  });

  it("shows a deletion marker for empty rules", () => {
    expect(
      approvalSummary(
        PROPOSE_RULES_TOOL,
        JSON.stringify({ content: "  ", reason: "不设限" }),
      ),
    ).toBe("理由：不设限\n新守则：\n（清空守则）");
  });

  it("truncates a long reason and keeps other tools at 200 JSON chars", () => {
    const summary = approvalSummary(
      PROPOSE_RULES_TOOL,
      JSON.stringify({ content: "a", reason: "r".repeat(400) }),
    );
    expect(summary).toContain(`${"r".repeat(300)}…`);
    expect(summary).not.toContain("r".repeat(301));

    const argsJson = JSON.stringify({ content: "x".repeat(400) });
    expect(approvalSummary("create_page", argsJson)).toBe(
      argsJson.slice(0, 200),
    );
    expect(approvalSummary(PROPOSE_RULES_TOOL, "not json")).toBe("not json");
  });
});
