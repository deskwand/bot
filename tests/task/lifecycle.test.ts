import { PiHarness } from "agents/harness/pi";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import type { TaskSpec } from "../../src/protocol";
import { scriptedModel } from "../helpers/scripted-model";
import { fakeChannel } from "../helpers/fake-channel";
import { seedOwnerAddress } from "../helpers/channel-ref";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

beforeEach(() => {
  setChannelOverride("telegram", fakeChannel().adapter);
});

afterEach(() => {
  setModelOverride(null);
  setChannelOverride("telegram", null);
  vi.restoreAllMocks();
});

function butler() {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

function task(taskId: string) {
  return env.TASK.get(env.TASK.idFromName(taskId));
}

function spec(taskId: string, instructions = "do the thing"): TaskSpec {
  return { taskId, title: `Task ${taskId}`, instructions };
}

describe("TaskDO lifecycle", () => {
  it("reports started and completed when the agent calls finish_task", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
      ]),
    );
    const taskId = "t1";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
        expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
        expect(events[1]?.payload).toMatchObject({
          type: "completed",
          summary: "ok",
          artifacts: [],
        });
      },
      { timeout: 10_000 },
    );

    expect(await stub.status()).toEqual({ state: "completed", title: "Task t1" });

    // Starting the same task again is a no-op: same operation, no new events.
    await stub.start(spec(taskId));
    expect(await butler().debugEvents(taskId)).toHaveLength(2);
  });

  it("uses spec.model on the first run", async () => {
    const chosen = scriptedModel([
      { toolCalls: [{ name: "finish_task", args: { summary: "chosen" } }] },
    ]);
    const taskId = "t-model";
    const stub = task(taskId);

    await stub.start({
      ...spec(taskId),
      // Scripted providers use their own ids, outside the anthropic union.
      model: chosen as unknown as TaskSpec["model"],
    });

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
        expect(events[1]?.payload).toMatchObject({
          type: "completed",
          summary: "chosen",
        });
      },
      { timeout: 10_000 },
    );
  });

  it("resubmits a start that was left queued", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "retried" } }] },
      ]),
    );
    const taskId = "t-retry";
    const stub = task(taskId);

    // Simulate a previous start that stored its spec but died before submit.
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO meta (key, value) VALUES ('task_id', ?), ('title', ?), ('spec', ?), ('state', 'queued')`,
        taskId,
        "Task t-retry",
        JSON.stringify(spec(taskId)),
      );
    });

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
        expect(events[1]?.payload).toMatchObject({ summary: "retried" });
      },
      { timeout: 10_000 },
    );
  });

  it("reports failed when the run rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(PiHarness.prototype, "wait").mockRejectedValue(
      new Error("model exploded"),
    );
    setModelOverride(scriptedModel([{ text: "never read" }]));
    const taskId = "t-fail";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "failed",
        ]);
        expect(events[1]?.payload).toMatchObject({
          type: "failed",
          reason: "model exploded",
          retryable: false,
        });
      },
      { timeout: 10_000 },
    );

    expect((await stub.status()).state).toBe("failed");
  });

  it("reports an unanswered run as failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(PiHarness.prototype, "wait").mockResolvedValue({
      operationId: "task:t-unanswered",
      session: "1",
      status: "unanswered",
      reason: "boom",
    });
    setModelOverride(scriptedModel([{ text: "never read" }]));
    const taskId = "t-unanswered";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
        expect(events[1]?.payload).toMatchObject({
          type: "failed",
          reason: "boom",
          retryable: false,
        });
        expect(events.some((event) => event.type === "completed")).toBe(false);
      },
      { timeout: 10_000 },
    );

    expect((await stub.status()).state).toBe("failed");
  });

  it("reports the last assistant text when finish_task was not called", async () => {
    setModelOverride(scriptedModel([{ text: "plain answer" }]));
    const taskId = "t2";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
        expect(events[1]?.payload).toMatchObject({
          type: "completed",
          summary: "plain answer",
          artifacts: [],
        });
      },
      { timeout: 10_000 },
    );

    expect((await stub.status()).state).toBe("completed");
  });

  it("only connects MCP tools when the task is queued or running", async () => {
    const taskId = `t-mcp-${crypto.randomUUID()}`;
    const stub = task(taskId);

    const result = await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as {
        setMeta(key: string, value: string): void;
        ensureMcpTools(): Promise<void>;
      };
      let calls = 0;
      target.ensureMcpTools = async () => {
        calls += 1;
      };

      target.setMeta("state", "completed");
      await instance.onStart();
      const completedCalls = calls;

      target.setMeta("state", "queued");
      await instance.onStart();
      target.setMeta("state", "running");
      await instance.onStart();

      return { completedCalls, calls };
    });

    expect(result.completedCalls).toBe(0);
    expect(result.calls).toBe(2);
  });

  it("still accepts gateway message events", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    await seedOwnerAddress("1");
    const route = await env.CHANNELS.get(
      env.CHANNELS.idFromName("channels"),
    ).currentRoute();

    // Non-text input exercises the RPC entry without opening pi, which this
    // file's Butler already set up with a different model catalog.
    await expect(
      butler().handleMessage({
        type: "message",
        channel: "telegram",
        chatId: "1",
        userId: "1",
        text: null,
        eventId: "tg:1",
        routeKey: route.routeKey,
      }),
    ).resolves.toBeUndefined();

    expect(channel.sent).toEqual([
      { chatId: "1", text: "目前只支持文字消息" },
    ]);
  });

  it("dedupes task events by seq", async () => {
    const taskId = "dedupe-1";
    const target = env.BUTLER.get(env.BUTLER.idFromName("dedupe-owner"));

    await target.report({ taskId, seq: 1, type: "started" });
    await target.report({ taskId, seq: 1, type: "started" });
    await target.report({ taskId, seq: 2, type: "progress", text: "a" });
    await target.report({ taskId, seq: 1, type: "started" });
    await target.report({ taskId, seq: 2, type: "progress", text: "a" });

    const events = await target.debugEvents(taskId);
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [1, "started"],
      [2, "progress"],
    ]);
  });
});
