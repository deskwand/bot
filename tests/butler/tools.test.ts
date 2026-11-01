import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TasksRepo } from "../../src/butler/tasks-repo";
import { createButlerTools } from "../../src/butler/tools";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import type { MessageEvent, TaskSpec } from "../../src/protocol";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function task(taskId: string) {
  return env.TASK.get(env.TASK.idFromName(taskId));
}

function message(evt: { text: string; updateId: number }): MessageEvent {
  return {
    type: "message",
    channel: "telegram",
    chatId: "42",
    userId: "1",
    ...evt,
  };
}

function spec(taskId: string): TaskSpec {
  return { taskId, title: `Task ${taskId}`, instructions: "do the thing" };
}

// A Butler opens pi with the model catalog as it is when the object starts, so
// register every scripted provider up front instead of inside a test.
const unknownIdsTranscript: string[] = [];
const unknownIdsModel = scriptedModel([
  {
    toolCalls: [
      { name: "steer_task", args: { id: "t99", text: "x" } },
      { name: "cancel_task", args: { id: "t99" } },
      { name: "retry_task", args: { id: "t99" } },
    ],
  },
  {
    text: "ok",
    observe: (context) =>
      unknownIdsTranscript.push(JSON.stringify(context.messages)),
  },
]);

const cancelTranscript: string[] = [];
const cancelModel = scriptedModel([
  { toolCalls: [{ name: "cancel_task", args: { id: "t-done" } }] },
  {
    text: "ok",
    observe: (context) =>
      cancelTranscript.push(JSON.stringify(context.messages)),
  },
]);

afterEach(() => {
  setModelOverride(null);
  setChannelOverride(null);
  vi.restoreAllMocks();
});

describe("butler control tools", () => {
  it("returns 没有任务 for unknown task ids", async () => {
    const channel = fakeChannel();
    setChannelOverride(channel.adapter);
    setModelOverride(unknownIdsModel);

    await butler("tools-201").handleMessage(
      message({ text: "处理 t99", updateId: 201 }),
    );

    expect(channel.sent.at(-1)).toEqual({ chatId: "42", text: "ok" });
    expect(unknownIdsTranscript[0]?.match(/没有任务 t99/g)).toHaveLength(3);
  });

  it("marks a task failed when TaskDO.start rejects", async () => {
    // Driven directly so the rejection happens in this context; a rejecting
    // Durable Object RPC would be logged as an uncaught exception by workerd.
    const result = await runInDurableObject(
      butler("tools-203"),
      async (_instance, state) => {
        const repo = new TasksRepo(state.storage.sql);
        let sent = 0;
        const tools = createButlerTools({
          repo,
          chatId: () => "42",
          send: async () => {
            sent += 1;
            return { messageId: "1" };
          },
          task: () => ({
            start: async () => {
              throw new Error("boom");
            },
            steer: async () => ({ ok: false, message: "" }),
            cancel: async () => ({ ok: false, message: "" }),
            retryTask: async () => ({ ok: false, message: "" }),
          }),
        });

        const spawn = tools.find((tool) => tool.name === "spawn_task");
        const outcome = await spawn!.execute(
          { title: "坏任务", instructions: "BOOM" } as never,
          {} as never,
          {} as never,
        );

        return {
          text: (outcome.output?.[0] as { text: string }).text,
          row: repo.get("t1"),
          sent,
        };
      },
    );

    expect(result.text).toBe("任务 t1 启动失败：boom");
    expect(result.row).toMatchObject({ status: "failed", summary: "boom" });
    expect(result.sent).toBe(0);
  });

  it("returns the task's refusal when cancelling a completed task", async () => {
    const channel = fakeChannel();
    setChannelOverride(channel.adapter);

    const taskId = "t-done";
    const stub = task(taskId);
    const taskModel = scriptedModel([
      { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
    ]);
    await stub.start({
      ...spec(taskId),
      model: taskModel as unknown as TaskSpec["model"],
    });
    await vi.waitFor(
      async () => {
        expect((await stub.status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    setModelOverride(cancelModel);

    await butler("owner").handleMessage(
      message({ text: "取消 t-done", updateId: 202 }),
    );

    expect(channel.sent).toEqual([{ chatId: "42", text: "ok" }]);
    expect(cancelTranscript[0]).toContain(`任务 ${taskId} 已完成，无法取消`);
    expect(await stub.status()).toMatchObject({ state: "completed" });
  });
});
