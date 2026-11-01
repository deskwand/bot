import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setModelOverride } from "../../src/llm/models";
import type { TaskSpec } from "../../src/protocol";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

afterEach(() => {
  setModelOverride(null);
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

  it("still accepts gateway message events", async () => {
    await expect(
      butler().handleMessage({
        type: "message",
        channel: "telegram",
        chatId: "1",
        userId: "1",
        text: "hello",
        updateId: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("dedupes task events by seq", async () => {
    const taskId = "dedupe-1";

    await butler().report({ taskId, seq: 1, type: "started" });
    await butler().report({ taskId, seq: 1, type: "started" });
    await butler().report({ taskId, seq: 2, type: "progress", text: "a" });
    await butler().report({ taskId, seq: 1, type: "started" });
    await butler().report({ taskId, seq: 2, type: "progress", text: "a" });

    const events = await butler().debugEvents(taskId);
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [1, "started"],
      [2, "progress"],
    ]);
  });
});
