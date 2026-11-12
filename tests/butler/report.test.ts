import { env, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiHarness } from "agents/harness/pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import type {
  ChannelMessageRef,
  OutboundMessage,
  RouteSnapshot,
} from "../../src/protocol";
import { createTelegramAdapter } from "../../src/channels/telegram";
import { ChannelError } from "../../src/channels/types";
import { setClockOverride, type Clock } from "../../src/butler/notifier";
import { setModelOverride } from "../../src/llm/models";
import type { LedgerStore } from "../../src/butler/ledger";
import { fakeChannel } from "../helpers/fake-channel";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

beforeEach(async () => {
  await seedOwnerAddress("42");
});

afterEach(() => {
  setClockOverride(null);
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  setModelOverride(null);
  vi.restoreAllMocks();
});

/** A Telegram Bot API stand-in that records bodies and hands out message ids. */
function fakeTelegramFetch(startId = 500) {
  const calls: {
    method: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: any;
  }[] = [];
  let nextId = startId;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, body });

    nextId += 1;
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: nextId } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  return { calls, fetchImpl };
}

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

type ButlerStub = ReturnType<typeof butler>;

/** A clock whose timers never fire; progress no longer schedules any. */
function fixedClock(now: number): Clock {
  return {
    now: () => now,
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
}

async function seedTask(
  stub: ButlerStub,
  row: {
    id?: string;
    title?: string;
    status?: string;
    chatId?: string | null;
  } = {},
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO tasks
        (id, title, status, created_at, updated_at, chat_id, artifacts_json,
         last_seq)
       VALUES (?, ?, ?, 0, 0, ?, '[]', 0)`,
      row.id ?? "t1",
      row.title ?? "查天气",
      row.status ?? "queued",
      row.chatId === undefined ? "42" : row.chatId,
    );
  });
}

async function taskRow(
  stub: ButlerStub,
  taskId: string,
): Promise<
  | {
      status: string;
      summary: string | null;
      last_progress: string | null;
      last_progress_at: number | null;
    }
  | undefined
> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{
        status: string;
        summary: string | null;
        last_progress: string | null;
        last_progress_at: number | null;
      }>(
        `SELECT status, summary, last_progress, last_progress_at
         FROM tasks WHERE id = ?`,
        taskId,
      )
      .toArray()[0],
  );
}

describe("ButlerDO.report", () => {
  it("speaks the summary without a butler session turn", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let targetRequests = 0;
    const large = scriptedModel([{ text: "original answer" }], { contextWindow: 1_000_000 });
    const small = scriptedModel([{ text: "must not run", observe: () => { targetRequests += 1; } }], { contextWindow: 128000 });
    setModelOverride(large);
    const stub = butler("report-window-refused");
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { harness: PiHarness }).harness.prompt("original detail", { operationId: "report-window-seed" });
    });
    const snapshot = () => runInDurableObject(stub, async (instance) => {
      const harness = (instance as unknown as { harness: PiHarness }).harness;
      const conversation = await (await harness.pi()).root(BACKGROUND_CONTEXT);
      return {
        model: (await conversation.agent(BACKGROUND_CONTEXT)).model,
        head: (await conversation.context(BACKGROUND_CONTEXT)).head?.id,
        entries: await harness.session().messages(),
      };
    });
    await seedTask(stub);
    const before = await snapshot();
    setModelOverride(small);
    await stub.report({ taskId: "t1", seq: 1, type: "completed", summary: "Result: 1 USD = 7.12 CNY", artifacts: [] });
    // The speaker is its own one-shot call, not a turn in the butler session.
    expect(targetRequests).toBe(1);
    expect(channel.sent.map((entry) => entry.text).join("\n")).toContain("Result: 1 USD = 7.12 CNY");
    expect(await snapshot()).toEqual(before);
  });

  it("starts a task without a card in the chat", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-spawn-silent");
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { taskFor(id: string): unknown }).taskFor = () => ({
        start: async () => {},
      });
    });

    expect(await stub.spawn("查天气", "查询北京天气")).toBe("t1");
    expect(channel.sent).toEqual([]);
    expect(channel.edits).toEqual([]);
  });

  it("records progress on the task row and keeps the chat quiet", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setClockOverride(fixedClock(12_345));

    const stub = butler("report-progress-silent");
    await seedTask(stub);

    await stub.report({ taskId: "t1", seq: 1, type: "started" });
    await stub.report({ taskId: "t1", seq: 2, type: "progress", text: "正在搜索" });
    await stub.report({ taskId: "t1", seq: 3, type: "progress", text: "正在搜索 机票" });

    expect(channel.sent).toEqual([]);
    expect(channel.edits).toEqual([]);
    expect(await taskRow(stub, "t1")).toMatchObject({
      status: "running",
      last_progress: "正在搜索 机票",
      last_progress_at: 12_345,
    });
  });

  it("records out-of-band progress on the task row only", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setClockOverride(fixedClock(99_000));

    const stub = butler("report-task-progress-silent");
    await seedTask(stub);

    await stub.reportTaskProgress("t1", "正在读 邮件");

    expect(channel.sent).toEqual([]);
    expect(channel.edits).toEqual([]);
    expect(await taskRow(stub, "t1")).toMatchObject({
      status: "queued",
      last_progress: "正在读 邮件",
      last_progress_at: 99_000,
    });
  });

  it("sends exactly one completion message", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-completed-silent-progress");
    await seedTask(stub);

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "ok",
      artifacts: [],
    });

    expect(channel.sent).toEqual([{ chatId: "42", text: "ok" }]);
    expect(channel.edits).toEqual([]);
  });

  it("says nothing when an owner task is cancelled", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-cancelled-silent");
    await seedTask(stub, { status: "running" });

    await stub.report({ taskId: "t1", seq: 1, type: "cancelled" });

    expect(channel.sent).toEqual([]);
    expect(channel.edits).toEqual([]);
    expect(await taskRow(stub, "t1")).toMatchObject({ status: "cancelled" });
  });

  it("still sends the summary when a butler submit would fail", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const stub = butler("report-terminal-broken");
    await seedTask(stub);
    // The report never goes through the session now; a broken submit must not
    // suppress the owner's terminal message.
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { harness: { submit(): Promise<never> } })
        .harness.submit = async () => {
        throw new Error("model unavailable");
      };
    });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "抓到了价格",
      artifacts: [],
    });

    expect(channel.sent).toEqual([
      { chatId: "42", text: "抓到了价格" },
    ]);
  });

  it("marks terminal, result and approval messages as critical", async () => {
    const stub = butler("report-priority");
    await seedTask(stub);

    const sent: OutboundMessage[] = [];
    await runInDurableObject(stub, (instance) => {
      (
        instance as unknown as {
          channels(): {
            currentRoute(): Promise<{
              channel: "telegram";
              routeKey: string;
            }>;
            isAdmissionCurrent(): Promise<boolean>;
            editCurrent(): Promise<boolean>;
            sendCurrent(msg: OutboundMessage): Promise<{
              channel: "telegram";
              conversationId: string;
              routeKey: string;
              messageId: string;
            }>;
          };
        }
      ).channels = () => ({
        currentRoute: async () => ({
          channel: "telegram",
          routeKey: "test-route",
        }),
        isAdmissionCurrent: async () => true,
        editCurrent: async () => false,
        sendCurrent: async (msg) => {
          sent.push(msg);
          return {
            channel: "telegram",
            conversationId: "42",
            routeKey: "test-route",
            messageId: "99",
          };
        },
      });
    });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "approval_requested",
      approvalId: "ap1",
      tool: "web_fetch",
      argsSummary: "a",
    });
    await stub.report({
      taskId: "t1",
      seq: 2,
      type: "completed",
      summary: "ok",
      artifacts: [],
    });

    expect(
      sent.find((message) => message.text.includes("请求执行 web_fetch"))
        ?.priority,
    ).toBe("critical");
    expect(
      sent.find((message) => message.text === "ok")?.priority,
    ).toBe("critical");
    expect(sent.filter((message) => message.text.includes("ok"))).toHaveLength(1);
  });

  it("sends an approval request with buttons and resolves it in place", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-approval");
    await seedTask(stub);

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "approval_requested",
      approvalId: "ap1",
      tool: "web_fetch",
      argsSummary: "https://example.com",
    });

    expect(channel.sent).toEqual([
      {
        chatId: "42",
        text: "t1 请求执行 web_fetch\nhttps://example.com",
        buttons: [
          [
            { label: "批准", data: "a:approve:t1:ap1", hint: "批准" },
            { label: "拒绝", data: "a:reject:t1:ap1", hint: "拒绝" },
          ],
        ],
      },
    ]);

    await stub.report({
      taskId: "t1",
      seq: 2,
      type: "approval_resolved",
      approvalId: "ap1",
      decision: "approved",
    });

    expect(channel.edits).toEqual([
      {
        chatId: "42",
        messageId: "1",
        text: "t1 请求执行 web_fetch\nhttps://example.com\n→ 已批准",
      },
    ]);
  });

  it("writes the full approval hint when another approval is pending", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-approval-multiple");
    await seedTask(stub);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE tasks SET handle = 1 WHERE id = 't1'`);
    });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "approval_requested",
      approvalId: "ap1",
      tool: "web_fetch",
      argsSummary: "a",
    });
    await stub.report({
      taskId: "t1",
      seq: 2,
      type: "approval_requested",
      approvalId: "ap2",
      tool: "web_fetch",
      argsSummary: "b",
    });

    // The first request was unambiguous when it was sent.
    expect(channel.sent[0]?.buttons).toEqual([
      [
        { label: "批准", data: "a:approve:t1:ap1", hint: "批准" },
        { label: "拒绝", data: "a:reject:t1:ap1", hint: "拒绝" },
      ],
    ]);
    // With two pending, the hint has to name the internal id: approval ids
    // are per task and handles are reused.
    expect(channel.sent[1]?.buttons).toEqual([
      [
        { label: "批准", data: "a:approve:t1:ap2", hint: "批准 t1 ap2" },
        { label: "拒绝", data: "a:reject:t1:ap2", hint: "拒绝 t1 ap2" },
      ],
    ]);
  });

  it("does not resolve text actions while maintenance is active", async () => {
    const stub = butler("report-maintenance-resolve");
    await stub.acquireMaintenance("export", "op1");

    expect(
      await stub.resolveTextAction({
        action: "cancel",
        target: { kind: "implicit" },
      }),
    ).toEqual({ kind: "reply", text: "维护中，稍后再试" });
  });

  it("derives the pending owner approvals from the event log", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-pending-owner");
    await seedTask(stub, { id: "t1", title: "查天气", status: "running" });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE tasks SET handle = 1 WHERE id = 't1'`);
    });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "approval_requested",
      approvalId: "ap1",
      tool: "web_fetch",
      argsSummary: "a",
    });
    await stub.report({
      taskId: "t1",
      seq: 2,
      type: "approval_requested",
      approvalId: "ap2",
      tool: "web_fetch",
      argsSummary: "b",
    });
    await stub.report({
      taskId: "t1",
      seq: 3,
      type: "approval_resolved",
      approvalId: "ap1",
      decision: "approved",
    });

    expect(await stub.pendingOwnerApprovals()).toEqual([
      { taskId: "t1", handle: 1, approvalId: "ap2", title: "查天气" },
    ]);
  });

  it("keeps bot approvals out of the pending owner list", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-pending-bot");
    await seedTask(stub, { id: "t1", title: "查天气", status: "running" });
    await seedTask(stub, { id: "b1", title: "bot run", status: "running" });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE tasks SET handle = 1 WHERE id = 't1'`);
      state.storage.sql.exec(`UPDATE tasks SET bot_id = 'bot-a' WHERE id = 'b1'`);
    });

    await stub.report({
      taskId: "b1",
      seq: 1,
      type: "approval_requested",
      approvalId: "ap1",
      tool: "web_fetch",
      argsSummary: "a",
    });

    expect(await stub.pendingOwnerApprovals()).toEqual([]);
  });

  it("keeps the approval outcome when the request text is long", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-approval-clamp");
    await seedTask(stub);

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "approval_requested",
      approvalId: "ap1",
      tool: "web_fetch",
      argsSummary: "z".repeat(5000),
    });
    expect(channel.sent[0]?.text.length).toBeLessThanOrEqual(4096);

    await stub.report({
      taskId: "t1",
      seq: 2,
      type: "approval_resolved",
      approvalId: "ap1",
      decision: "approved",
    });
    expect(channel.edits[0]?.text.length).toBeLessThanOrEqual(4096);
    expect(channel.edits[0]?.text.endsWith("\n→ 已批准")).toBe(true);
  });

  it("resolves the approval on the message id the real adapter returned", async () => {
    const { calls, fetchImpl } = fakeTelegramFetch();
    setChannelOverride(
      "telegram",
      createTelegramAdapter({
        token: "123:test-token",
        fetch: fetchImpl,
      }),
    );

    const stub = butler("report-approval-entities");
    await seedTask(stub);

    const argsSummary = "**甲** ".repeat(100);
    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "approval_requested",
      approvalId: "ap1",
      tool: "web_fetch",
      argsSummary,
    });

    // The rendered request carries bold entities (100 of them, so the library
    // splits it) and the buttons ride on the last chunk only.
    const sends = calls.filter((call) => call.method === "sendMessage");
    expect(sends.length).toBeGreaterThan(1);
    expect(sends[0].body.entities.length).toBeGreaterThan(0);
    expect(sends[0].body).not.toHaveProperty("parse_mode");
    expect(sends.slice(0, -1).every((c) => c.body.reply_markup === undefined)).toBe(
      true,
    );
    expect(
      sends[sends.length - 1].body.reply_markup.inline_keyboard[0][0]
        .callback_data,
    ).toBe("a:approve:t1:ap1");

    const saved = await runInDurableObject(stub, (_instance, state) => {
      const json = state.storage.sql
        .exec<{ message_ref_json: string }>(
          `SELECT message_ref_json FROM approval_messages WHERE approval_id = ?`,
          "ap1",
        )
        .toArray()[0]?.message_ref_json;
      return (JSON.parse(json ?? "null") as { messageId: string | null } | null)
        ?.messageId;
    });
    expect(saved).toBe(String(500 + sends.length));

    await stub.report({
      taskId: "t1",
      seq: 2,
      type: "approval_resolved",
      approvalId: "ap1",
      decision: "approved",
    });

    const edits = calls.filter((call) => call.method === "editMessageText");
    expect(edits).toHaveLength(1);
    expect(edits[0].body.message_id).toBe(saved);
    expect(edits[0].body.text).toBe(
      `t1 请求执行 web_fetch\n${argsSummary}\n→ 已批准`,
    );
    expect(edits[0].body.text.endsWith("\n→ 已批准")).toBe(true);
  });

  it("marks completion and sends the summary directly", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-completed");
    await seedTask(stub);

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "ok",
      artifacts: [],
    });

    expect(channel.edits).toEqual([]);
    expect(channel.sent).toEqual([{ chatId: "42", text: "ok" }]);
    expect(await taskRow(stub, "t1")).toMatchObject({
      status: "completed",
      summary: "ok",
    });

    const entries = await runInDurableObject(stub, (instance) =>
      instance.harness.messages(),
    );
    expect(
      entries.find((entry) => entry.kind === "task.completed"),
    ).toBeUndefined();
  });

  it("does not submit the completion summary to the butler session", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-completion-bypass");
    await seedTask(stub);
    let submits = 0;
    await runInDurableObject(stub, (instance) => {
      (
        instance as unknown as {
          harness: { submit(...args: unknown[]): Promise<never> };
        }
      ).harness.submit = async () => {
        submits += 1;
        throw new Error("must not submit");
      };
    });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "ok",
      artifacts: [],
    });

    expect(submits).toBe(0);
    expect(channel.sent).toEqual([{ chatId: "42", text: "ok" }]);
  });

  it("writes one ledger row per completed task", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-ledger");
    await seedTask(stub);

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "抓到了价格",
      artifacts: [],
    });

    const rows = await runInDurableObject(stub, (instance) =>
      (instance as unknown as { ledger: LedgerStore }).ledger.pending().rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "butler.said",
      refId: "t1",
      line: "我对主人说了：抓到了价格",
    });
  });

  it("does not rebuild a legacy task report as an owner turn", async () => {
    const stub = butler("report-legacy-sweep");
    const aborted: string[] = [];
    await runInDurableObject(stub, (instance) => {
      const harness = (
        instance as unknown as {
          harness: {
            pending(): Promise<{ operationId: string }[]>;
            abort(args: { operationId: string }): Promise<void>;
          };
        }
      ).harness;
      harness.pending = async () => [{ operationId: "task-completed:t1" }];
      harness.abort = async ({ operationId }) => {
        aborted.push(operationId);
      };
    });

    const rows = await runInDurableObject(stub, async (instance, state) => {
      await (
        instance as unknown as {
          runSweep(now: number): Promise<number | null>;
        }
      ).runSweep(1_000);
      return state.storage.sql
        .exec<{ operation_id: string }>(`SELECT operation_id FROM butler_turns`)
        .toArray();
    });

    expect(rows).toEqual([]);
    expect(aborted).toEqual(["task-completed:t1"]);
  });

  it("does not send a second completion report for a redelivered event", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-completed-idempotent");
    await seedTask(stub);

    const completed = {
      taskId: "t1",
      type: "completed" as const,
      summary: "ok",
      artifacts: [],
    };
    await stub.report({ ...completed, seq: 1 });
    expect(channel.sent).toHaveLength(1);

    // Same seq: dropped by the event dedupe.
    await stub.report({ ...completed, seq: 1 });

    expect(channel.sent).toHaveLength(1);
  });

  it("reports a completed task only once when the completion is redelivered with a higher seq", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-completed-redelivered");
    await seedTask(stub);
    await env.ARTIFACTS.put("t1/f1/report.md", "# body", {
      httpMetadata: { contentType: "text/markdown" },
    });

    const completed = {
      taskId: "t1",
      type: "completed" as const,
      summary: "ok",
      artifacts: [{ name: "report.md", key: "t1/f1/report.md" }],
    };
    await stub.report({ ...completed, seq: 2 });
    await stub.report({ ...completed, seq: 3 });

    expect(channel.sent.map((message) => message.text)).toEqual([
      "ok",
    ]);
    expect(channel.artifacts).toEqual([
      { chatId: "42", name: "report.md", contentType: "text/markdown" },
    ]);
  });

  it("shows the retry hint for a retryable failure", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-failed");
    await seedTask(stub);

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "failed",
      reason: "模型错误",
      retryable: true,
    });

    expect(channel.sent).toEqual([
      { chatId: "42", text: "「查天气」没办成：模型错误\n要我重试吗？" },
    ]);
    expect(channel.edits).toEqual([]);
    expect(await taskRow(stub, "t1")).toMatchObject({ status: "failed" });
  });

  it("clamps a long failure message", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-clamps");
    await seedTask(stub);

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "failed",
      reason: "y".repeat(5000),
      retryable: true,
    });
    const failure = channel.sent[0]?.text ?? "";
    expect(failure.length).toBeLessThanOrEqual(4096);
    expect(failure.startsWith("「查天气」没办成：")).toBe(true);
  });
});

describe("ButlerDO.report stalled", () => {
  type Boundary = {
    currentRoute(): Promise<{ channel: "telegram"; routeKey: string }>;
    isAdmissionCurrent(): Promise<boolean>;
    editCurrent(ref: ChannelMessageRef): Promise<boolean>;
    sendCurrent(msg: OutboundMessage): Promise<ChannelMessageRef>;
  };

  async function capture(stub: ButlerStub): Promise<{
    sent: OutboundMessage[];
    edited: ChannelMessageRef[];
  }> {
    const sent: OutboundMessage[] = [];
    const edited: ChannelMessageRef[] = [];
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { channels(): Boundary }).channels = () => ({
        currentRoute: async () => ({
          channel: "telegram",
          routeKey: "test-route",
        }),
        isAdmissionCurrent: async () => true,
        editCurrent: async (ref) => {
          edited.push(ref);
          return true;
        },
        sendCurrent: async (msg) => {
          sent.push(msg);
          return {
            channel: "telegram",
            conversationId: "42",
            routeKey: "test-route",
            messageId: String(sent.length),
          };
        },
      });
    });
    return { sent, edited };
  }

  const stalledTool = {
    activity: { kind: "running_tool" as const, tool: "web_fetch" },
    idleMs: 600_000,
  };

  it("sends one alert for a stalled tool", async () => {
    const stub = butler("report-stalled-tool");
    const { sent } = await capture(stub);
    await seedTask(stub, { status: "running" });

    await stub.report({ taskId: "t1", seq: 1, type: "stalled", ...stalledTool });

    expect(sent).toEqual([
      {
        text: expect.stringContaining(
          "最后一步「web_fetch」已经 10 分钟没有返回",
        ),
        priority: "alert",
      },
    ]);
  });

  it("says it is waiting for the model", async () => {
    const stub = butler("report-stalled-model");
    const { sent } = await capture(stub);
    await seedTask(stub, { status: "running" });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "stalled",
      activity: { kind: "waiting_model" },
      idleMs: 600_000,
    });

    expect(sent.at(-1)?.text).toContain("在等模型响应");
    expect(sent.at(-1)?.text).toContain("已经 10 分钟没有进展");
  });

  it("ignores a stalled event for a task that already ended", async () => {
    const stub = butler("report-stalled-finished");
    const { sent } = await capture(stub);
    await seedTask(stub, { status: "running" });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "ok",
      artifacts: [],
    });
    const before = sent.length;

    await stub.report({ taskId: "t1", seq: 2, type: "stalled", ...stalledTool });

    expect(sent).toHaveLength(before);
  });

  it("ignores a stalled event for a bot task", async () => {
    const stub = butler("report-stalled-bot");
    const { sent } = await capture(stub);
    await seedTask(stub, { id: "b1", status: "running" });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE tasks SET bot_id = 'bot-a' WHERE id = 'b1'`);
    });

    await stub.report({ taskId: "b1", seq: 1, type: "stalled", ...stalledTool });

    expect(sent).toEqual([]);
  });

  it("sends the stalled notice as its own message", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const stub = butler("report-stalled-ref");
    await seedTask(stub, { status: "running" });

    await stub.report({ taskId: "t1", seq: 1, type: "started" });
    await stub.report({ taskId: "t1", seq: 2, type: "stalled", ...stalledTool });
    expect(channel.sent.map((message) => message.text).join("\n")).toContain(
      "最后一步「web_fetch」",
    );

    await stub.report({
      taskId: "t1",
      seq: 3,
      type: "completed",
      summary: "ok",
      artifacts: [],
    });

    expect(channel.sent.map((message) => message.text)).toEqual([
      expect.stringContaining("最后一步「web_fetch」"),
      "ok",
    ]);
    expect(channel.edits).toEqual([]);
  });
});

describe("ButlerDO.reconcileChannel", () => {
  type Boundary = {
    currentRoute: RouteSnapshot;
    sends: OutboundMessage[];
    failSend: boolean;
    explicitTargets: string[];
  };

  function boundary(routeKey = "k1"): Boundary {
    return {
      currentRoute: { channel: "telegram", routeKey },
      sends: [],
      failSend: false,
      explicitTargets: [],
    };
  }

  async function stubBoundary(
    stub: ButlerStub,
    state: Boundary,
  ): Promise<void> {
    await runInDurableObject(stub, (instance) => {
      (
        instance as unknown as { channels(): unknown }
      ).channels = () => ({
        currentRoute: async () => state.currentRoute,
        isAdmissionCurrent: async (
          channel: string,
          routeKey: string,
        ) =>
          state.currentRoute.channel === channel &&
          state.currentRoute.routeKey === routeKey,
        sendCurrent: async (msg: OutboundMessage) => {
          if (state.failSend) throw new Error("wechat context missing");
          state.sends.push(msg);
          const route = state.currentRoute;
          return {
            channel: route.channel!,
            conversationId: "42",
            routeKey: route.routeKey,
            messageId: String(state.sends.length),
          };
        },
        editCurrent: async () => true,
        send: async () => {
          state.explicitTargets.push("send");
        },
        edit: async () => {
          state.explicitTargets.push("edit");
        },
      });
    });
  }

  async function stubPending(
    stub: ButlerStub,
    pending: { approvalId: string; tool: string; argsSummary: string }[],
  ): Promise<void> {
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { taskFor(id: string): unknown }).taskFor = () => ({
        start: async () => {},
        status: async () => ({ state: "running", title: "" }),
        steer: async () => ({ ok: false, message: "" }),
        cancel: async () => ({ ok: false, message: "" }),
        retryTask: async () => ({ ok: false, message: "" }),
        continueTask: async () => ({ ok: false, message: "" }),
        pendingApprovals: async () => pending,
      });
    });
  }

  const AP1 = {
    approvalId: "ap1",
    tool: "web_fetch",
    argsSummary: "https://example.com",
  };

  it("retries a failed send, presents once per route, and re-presents after a redeploy", async () => {
    const stub = butler("reconcile-routes");
    await seedTask(stub, { status: "running" });
    const state = boundary("k1");
    state.failSend = true;
    await stubBoundary(stub, state);
    await stubPending(stub, [AP1]);

    await stub.reconcileChannel("k1");
    expect(state.sends).toEqual([]);

    state.failSend = false;
    await stub.reconcileChannel("k1");
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]?.text).toContain("请求执行 web_fetch");

    // Same deployment and route: the saved reference suppresses duplicates.
    await stub.reconcileChannel("k1");
    expect(state.sends).toHaveLength(1);

    // A new deployment owns new references, so the approval is re-presented.
    state.currentRoute = { channel: "telegram", routeKey: "k2" };
    await stub.reconcileChannel("k2");
    expect(state.sends).toHaveLength(2);

    // A stale key from another deployment is ignored.
    await stub.reconcileChannel("k1");
    expect(state.sends).toHaveLength(2);
    expect(state.explicitTargets).toEqual([]);
  });

  it("presents nothing when the task has no live pending approval", async () => {
    const stub = butler("reconcile-none");
    await seedTask(stub, { status: "running" });
    const state = boundary();
    await stubBoundary(stub, state);
    await stubPending(stub, []);

    await stub.reconcileChannel("k1");

    expect(state.sends).toEqual([]);
  });

  it("presents nothing for a task that is already terminal", async () => {
    const stub = butler("reconcile-terminal");
    await seedTask(stub, { status: "completed" });
    const state = boundary();
    await stubBoundary(stub, state);
    await stubPending(stub, [AP1]);

    await stub.reconcileChannel("k1");

    expect(state.sends).toEqual([]);
  });

  it("reconciles after a task report", async () => {
    const stub = butler("reconcile-report");
    await seedTask(stub, { status: "running" });
    const state = boundary();
    await stubBoundary(stub, state);
    await stubPending(stub, [AP1]);

    await stub.report({ taskId: "t1", seq: 1, type: "started" });

    await vi.waitFor(() => {
      expect(state.sends).toHaveLength(1);
    });
  });
});

describe("ButlerDO.report artifacts", () => {
  it("sends each artifact after the report text", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const stub = butler("report-artifacts");
    await seedTask(stub);
    await env.ARTIFACTS.put("t1/f1/report.md", "# body", {
      httpMetadata: { contentType: "text/markdown" },
    });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "ok",
      artifacts: [{ name: "report.md", key: "t1/f1/report.md" }],
    });

    expect(channel.sent.map((message) => message.text)).toEqual([
      "ok",
    ]);
    expect(channel.artifacts).toEqual([
      { chatId: "42", name: "report.md", contentType: "text/markdown" },
    ]);
  });

  it("tells the owner when an artifact could not be sent", async () => {
    const channel = fakeChannel();
    channel.adapter.sendArtifact = async () => {
      throw new ChannelError("upstream", 502);
    };
    setChannelOverride("telegram", channel.adapter);
    const stub = butler("report-artifact-failed");
    await seedTask(stub);
    await env.ARTIFACTS.put("t1/f1/report.md", "# body");

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "ok",
      artifacts: [{ name: "report.md", key: "t1/f1/report.md" }],
    });

    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[1]!.text).toContain("report.md");
    expect(channel.sent[1]!.text).toContain("未能送达");
  });
});
