import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import type { ChannelAdapter } from "../../src/channels/types";
import { ChannelError } from "../../src/channels/types";
import { setClockOverride, type Clock } from "../../src/butler/notifier";
import { setModelOverride } from "../../src/llm/models";
import type { TaskEvent } from "../../src/protocol";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

afterEach(() => {
  setClockOverride(null);
  setChannelOverride(null);
  setModelOverride(null);
  vi.restoreAllMocks();
});

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

type ButlerStub = ReturnType<typeof butler>;

type FakeClock = {
  clock: Clock;
  now(): number;
  advance(ms: number): void;
};

/** A deterministic clock; timers poll the manual time so callbacks stay in the DO. */
function fakeClock(start = 0): FakeClock {
  let now = start;
  let nextId = 1;
  const timers = new Map<
    number,
    { at: number; run: () => void; cancelled: boolean }
  >();

  return {
    clock: {
      now: () => now,
      setTimeout(run, delayMs) {
        const id = nextId++;
        const timer = { at: now + delayMs, run, cancelled: false };
        timers.set(id, timer);

        const poll = () => {
          if (timer.cancelled) return;
          if (now >= timer.at) {
            timers.delete(id);
            run();
            return;
          }
          setTimeout(poll, 1);
        };
        setTimeout(poll, 1);
        return id;
      },
      clearTimeout(handle) {
        if (typeof handle !== "number") return;
        const timer = timers.get(handle);
        if (timer === undefined) return;
        timer.cancelled = true;
        timers.delete(handle);
      },
    },
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

async function seedTask(
  stub: ButlerStub,
  row: {
    id?: string;
    title?: string;
    status?: string;
    chatId?: string | null;
    progressMessageId?: string | null;
  } = {},
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO tasks
        (id, title, status, created_at, updated_at, chat_id, progress_message_id, artifacts_json, last_seq)
       VALUES (?, ?, ?, 0, 0, ?, ?, '[]', 0)`,
      row.id ?? "t1",
      row.title ?? "查天气",
      row.status ?? "queued",
      row.chatId === undefined ? "42" : row.chatId,
      row.progressMessageId === undefined ? "77" : row.progressMessageId,
    );
  });
}

async function taskRow(
  stub: ButlerStub,
  taskId: string,
): Promise<{ status: string; summary: string | null } | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ status: string; summary: string | null }>(
        `SELECT status, summary FROM tasks WHERE id = ?`,
        taskId,
      )
      .toArray()[0],
  );
}

describe("ButlerDO.report", () => {
  it("edits progress immediately, then flushes the latest text after the interval", async () => {
    const channel = fakeChannel();
    setChannelOverride(channel.adapter);
    const fake = fakeClock();
    setClockOverride(fake.clock);

    const stub = butler("report-progress");
    await seedTask(stub);

    await stub.report({ taskId: "t1", seq: 1, type: "started" });
    await stub.report({ taskId: "t1", seq: 2, type: "progress", text: "a" });
    expect(channel.edits).toEqual([
      { chatId: "42", messageId: "77", text: "⏳ t1 查天气：a", buttons: [
        [{ label: "取消", data: "a:cancel:t1" }],
      ] },
    ]);

    await stub.report({ taskId: "t1", seq: 3, type: "progress", text: "b" });
    await stub.report({ taskId: "t1", seq: 4, type: "progress", text: "c" });
    expect(channel.edits).toHaveLength(1);

    fake.advance(3000);
    await vi.waitFor(() => {
      expect(channel.edits).toHaveLength(2);
    });
    expect(channel.edits[1]?.text).toBe("⏳ t1 查天气：c");
    expect(await taskRow(stub, "t1")).toMatchObject({ status: "running" });
  });

  it("sends an approval request with buttons and resolves it in place", async () => {
    const channel = fakeChannel();
    setChannelOverride(channel.adapter);
    const fake = fakeClock();
    setClockOverride(fake.clock);

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
        text: "🔐 t1 请求执行 web_fetch\nhttps://example.com",
        buttons: [
          [
            { label: "✅ 批准", data: "a:approve:t1:ap1" },
            { label: "❌ 拒绝", data: "a:reject:t1:ap1" },
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
        text: "🔐 t1 请求执行 web_fetch\nhttps://example.com\n→ 已批准",
      },
    ]);
  });

  it("marks completion, asks the butler to report, and sends the answer", async () => {
    const channel = fakeChannel();
    setChannelOverride(channel.adapter);
    const fake = fakeClock();
    setClockOverride(fake.clock);
    setModelOverride(scriptedModel([{ text: "t1 完成：ok" }]));

    const stub = butler("report-completed");
    await seedTask(stub);

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "ok",
      artifacts: [],
    });

    expect(channel.edits).toEqual([
      { chatId: "42", messageId: "77", text: "✅ t1 查天气：已完成" },
    ]);
    expect(channel.sent).toEqual([{ chatId: "42", text: "t1 完成：ok" }]);
    expect(await taskRow(stub, "t1")).toMatchObject({
      status: "completed",
      summary: "ok",
    });

    const entries = await runInDurableObject(stub, (instance) =>
      instance.harness.messages(),
    );
    expect(entries.find((entry) => entry.kind === "task.completed")?.data).toMatchObject({
      id: "t1",
      summary: "ok",
      artifacts: [],
    });
  });

  it("survives a channel edit failure and sends new progress next time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const channel = fakeChannel();
    const failing: ChannelAdapter = {
      ...channel.adapter,
      async edit() {
        throw new ChannelError("Too Many Requests", 429);
      },
    };
    setChannelOverride(failing);
    const fake = fakeClock();
    setClockOverride(fake.clock);

    const stub = butler("report-channel-failure");
    await seedTask(stub);

    await expect(
      stub.report({ taskId: "t1", seq: 1, type: "progress", text: "a" }),
    ).resolves.toBeUndefined();
    expect(channel.sent).toHaveLength(0);
    expect(channel.edits).toHaveLength(0);

    fake.advance(3000);
    await stub.report({ taskId: "t1", seq: 2, type: "progress", text: "b" });

    expect(channel.sent).toEqual([
      {
        chatId: "42",
        text: "⏳ t1 查天气：b",
        buttons: [[{ label: "取消", data: "a:cancel:t1" }]],
      },
    ]);
  });

  it("shows the retry hint for a retryable failure", async () => {
    const channel = fakeChannel();
    setChannelOverride(channel.adapter);
    const fake = fakeClock();
    setClockOverride(fake.clock);

    const stub = butler("report-failed");
    await seedTask(stub);

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "failed",
      reason: "模型错误",
      retryable: true,
    });

    expect(channel.edits).toEqual([
      {
        chatId: "42",
        messageId: "77",
        text: "❌ t1 查天气：模型错误\n回复\"重试 t1\"可继续",
      },
    ]);
    expect(await taskRow(stub, "t1")).toMatchObject({ status: "failed" });
  });

  it("marks a cancelled task and its progress message", async () => {
    const channel = fakeChannel();
    setChannelOverride(channel.adapter);
    const fake = fakeClock();
    setClockOverride(fake.clock);

    const stub = butler("report-cancelled");
    await seedTask(stub);

    await stub.report({ taskId: "t1", seq: 1, type: "cancelled" });

    expect(channel.edits).toEqual([
      { chatId: "42", messageId: "77", text: "🚫 t1 查天气：已取消" },
    ]);
    expect(await taskRow(stub, "t1")).toMatchObject({ status: "cancelled" });
  });

  it("updates state without channel output when the chat is unknown", async () => {
    const channel = fakeChannel();
    setChannelOverride(channel.adapter);
    const fake = fakeClock();
    setClockOverride(fake.clock);

    const stub = butler("report-no-chat");
    await seedTask(stub, { chatId: null, progressMessageId: null });

    const events: TaskEvent[] = [
      { taskId: "t1", seq: 1, type: "progress", text: "a" },
      { taskId: "t1", seq: 2, type: "cancelled" },
    ];
    for (const event of events) await stub.report(event);

    expect(channel.sent).toHaveLength(0);
    expect(channel.edits).toHaveLength(0);
    expect(await taskRow(stub, "t1")).toMatchObject({ status: "cancelled" });
  });
});
