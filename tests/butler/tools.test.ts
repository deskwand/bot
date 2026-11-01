import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";import { setChannelOverride } from "../../src/channels/override";
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

afterEach(() => {
  setModelOverride(null);
  setChannelOverride(null);
});

describe("butler control tools", () => {
  it("returns 没有任务 for unknown task ids", async () => {
    const channel = fakeChannel();
    setChannelOverride(channel.adapter);

    const transcript: string[] = [];
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            { name: "steer_task", args: { id: "t99", text: "x" } },
            { name: "cancel_task", args: { id: "t99" } },
            { name: "retry_task", args: { id: "t99" } },
          ],
        },
        {
          text: "ok",
          observe: (context) => transcript.push(JSON.stringify(context.messages)),
        },
      ]),
    );

    await butler("tools-201").handleMessage(
      message({ text: "处理 t99", updateId: 201 }),
    );

    expect(channel.sent.at(-1)).toEqual({ chatId: "42", text: "ok" });
    expect(transcript[0]?.match(/没有任务 t99/g)).toHaveLength(3);
  });

  it("returns the task's refusal when cancelling a completed task", async () => {
    const channel = fakeChannel();
    setChannelOverride(channel.adapter);

    // Register the Butler's provider before the task's reports instantiate the
    // Butler: its model catalog is fixed when the object opens pi.
    const transcript: string[] = [];
    const butlerModel = scriptedModel([
      { toolCalls: [{ name: "cancel_task", args: { id: "t-done" } }] },
      {
        text: "ok",
        observe: (context) => transcript.push(JSON.stringify(context.messages)),
      },
    ]);

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

    setModelOverride(butlerModel);

    await butler("owner").handleMessage(
      message({ text: "取消 t-done", updateId: 202 }),
    );

    expect(channel.sent).toEqual([{ chatId: "42", text: "ok" }]);
    expect(transcript[0]).toContain(`任务 ${taskId} 已完成，无法取消`);
    expect(await stub.status()).toMatchObject({ state: "completed" });
  });
});
