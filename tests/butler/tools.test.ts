import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/butler/memory";
import { TasksRepo } from "../../src/butler/tasks-repo";
import { createButlerTools, SpawnFailedError } from "../../src/butler/tools";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import type { AdmittedMessage, RouteSnapshot, TaskSpec } from "../../src/protocol";
import { fakeChannel } from "../helpers/fake-channel";
import { currentChannelRef, seedOwnerAddress } from "../helpers/channel-ref";
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

let route: RouteSnapshot;

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

function message(evt: { text: string; eventId: string }): AdmittedMessage {
  return {
    type: "message",
    channel: "telegram",
    chatId: "42",
    userId: "1",
    ...evt,
    routeKey: route.routeKey,
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

beforeEach(async () => {
  await seedOwnerAddress("42");
  route = await channels().currentRoute();
});

afterEach(() => {
  setModelOverride(null);
  setChannelOverride("telegram", null);
  vi.restoreAllMocks();
});

describe("butler control tools", () => {
  it("returns 没有任务 for unknown task ids", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(unknownIdsModel);

    await butler("tools-201").handleMessage(
      message({ text: "处理 t99", eventId: "tg:201" }),
    );

    expect(channel.sent.at(-1)).toEqual({ chatId: "42", text: "ok" });
    expect(unknownIdsTranscript[0]?.match(/没有任务 t99/g)).toHaveLength(3);
  });

  it("reports a failed spawn to the model", async () => {
    const result = await runInDurableObject(
      butler("tools-203"),
      async (_instance, state) => {
        const repo = new TasksRepo(state.storage.sql);
        const tools = createButlerTools({
          repo,
          task: () => ({
            start: async () => {},
            status: async () => ({ state: "queued", title: "" }),
            steer: async () => ({ ok: false, message: "" }),
            cancel: async () => ({ ok: false, message: "" }),
            retryTask: async () => ({ ok: false, message: "" }),
            pendingApprovals: async () => [],
          }),
          spawn: async () => {
            throw new SpawnFailedError("t1", "boom");
          },
          memory: new MemoryStore(state.storage.sql),
          createSchedule: async () => "s1",
          listSchedules: () => [],
          removeSchedule: async () => false,
        });

        const spawn = tools.find((tool) => tool.name === "spawn_task");
        const outcome = await spawn!.execute(
          { title: "坏任务", instructions: "BOOM" } as never,
          {} as never,
          {} as never,
        );

        return (outcome.output?.[0] as { text: string }).text;
      },
    );

    expect(result).toBe("任务 t1 启动失败：boom");
  });

  it("retry_task refuses a bot task", async () => {
    const result = await runInDurableObject(
      butler("tools-retry-bot"),
      async (_instance, state) => {
        const repo = new TasksRepo(state.storage.sql);
        repo.insert({ id: "t1", title: "盯价格", chatId: null, botId: "b1" });
        let retried = false;
        const tools = createButlerTools({
          repo,
          task: () => ({
            start: async () => {},
            status: async () => ({ state: "failed", title: "盯价格" }),
            steer: async () => ({ ok: false, message: "" }),
            cancel: async () => ({ ok: false, message: "" }),
            retryTask: async () => {
              retried = true;
              return { ok: true, message: "已重试" };
            },
            pendingApprovals: async () => [],
          }),
          spawn: async () => "t2",
          memory: new MemoryStore(state.storage.sql),
          createSchedule: async () => "s1",
          listSchedules: () => [],
          removeSchedule: async () => false,
        });

        const retry = tools.find((tool) => tool.name === "retry_task");
        const outcome = await retry!.execute(
          { id: "t1" } as never,
          {} as never,
          {} as never,
        );
        return {
          text: (outcome.output?.[0] as { text: string }).text,
          retried,
        };
      },
    );

    expect(result).toEqual({
      text: "任务 t1 属于机器人 b1，请用 wake_bot 让它重新运行",
      retried: false,
    });
  });

  it("asks the Task DO to flush before get_task reads the row", async () => {
    const result = await runInDurableObject(
      butler("tools-get-flush"),
      async (instance, state) => {
        const repo = new TasksRepo(state.storage.sql);
        repo.insert({ id: "t1", title: "查天气", chatId: "42" });
        const calls: string[] = [];
        (
          instance as unknown as { taskFor(id: string): unknown }
        ).taskFor = (id: string) => ({
          status: async () => {
            calls.push(id);
            return { state: "running", title: "查天气" };
          },
        });

        const entry = instance.registry
          .snapshot()
          .tools()
          .find(({ tool }) => tool.name === "get_task");
        const outcome = await entry!.tool.execute(
          { id: "t1" } as never,
          {} as never,
          {} as never,
        );
        return {
          calls,
          text: (outcome.output?.[0] as { text: string }).text,
        };
      },
    );

    expect(result.calls).toEqual(["t1"]);
    expect(result.text).toContain("#1（id t1）[queued] 查天气");
  });

  it("sends the start message before the Task DO can report progress", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const result = await runInDurableObject(
      butler("tools-spawn-order"),
      async (instance, state) => {
        (
          instance as unknown as { taskFor(id: string): unknown }
        ).taskFor = (id: string) => ({
          start: async () => {
            await instance.report({
              taskId: id,
              seq: 1,
              type: "progress",
              text: "早期进度",
            });
          },
        });

        await instance.spawn("查天气", "查询北京天气", {
          channel: "telegram",
          conversationId: "42",
        });
        return new TasksRepo(state.storage.sql).get("t1");
      },
    );

    expect(result).toMatchObject({
      id: "t1",
      progressMessageRef: {
        ...(await currentChannelRef("1")),
      },
      status: "queued",
    });
    expect(channel.sent).toEqual([
      {
        chatId: "42",
        text: "⏳ #1 查天气：已开始",
        buttons: [
          [{ label: "取消", data: "a:cancel:t1", hint: "取消 #1" }],
        ],
      },
    ]);
    expect(channel.edits).toEqual([
      {
        chatId: "42",
        messageId: "1",
        text: "⏳ #1 查天气：早期进度",
        buttons: [
          [{ label: "取消", data: "a:cancel:t1", hint: "取消 #1" }],
        ],
      },
    ]);
  });

  it("edits the start message when the Task DO cannot start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const result = await runInDurableObject(
      butler("tools-spawn-failure-edit"),
      async (instance, state) => {
        (
          instance as unknown as { taskFor(id: string): unknown }
        ).taskFor = () => ({
          start: async () => {
            throw new Error("boom");
          },
        });

        try {
          await instance.spawn("坏任务", "BOOM", {
            channel: "telegram",
            conversationId: "42",
          });
        } catch (error) {
          return {
            message: (error as Error).message,
            row: new TasksRepo(state.storage.sql).get("t1"),
          };
        }
        return null;
      },
    );

    expect(result?.message).toBe("boom");
    expect(result?.row).toMatchObject({ status: "failed", summary: "boom" });
    expect(channel.edits).toEqual([
      { chatId: "42", messageId: "1", text: "❌ #1 坏任务：boom" },
    ]);
  });

  it("marks a task failed when its Task DO cannot start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const result = await runInDurableObject(
      butler("tools-204"),
      async (instance, state) => {
        // A rejecting Task DO RPC would be logged as an uncaught exception by
        // workerd, so replace the binding lookup with a failable control.
        (
          instance as unknown as { taskFor(id: string): unknown }
        ).taskFor = () => ({
          start: async () => {
            throw new Error("boom");
          },
        });

        try {
          await instance.spawn("坏任务", "BOOM");
          return null;
        } catch (error) {
          return {
            name: (error as Error).name,
            message: (error as Error).message,
            row: new TasksRepo(state.storage.sql).get("t1"),
          };
        }
      },
    );

    expect(result?.message).toBe("boom");
    expect(result?.row).toMatchObject({
      id: "t1",
      status: "failed",
      summary: "boom",
    });
  });

  it("returns the task's refusal when cancelling a completed task", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

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
      message({ text: "取消 t-done", eventId: "tg:202" }),
    );

    expect(channel.sent.at(-1)).toEqual({ chatId: "42", text: "ok" });
    expect(cancelTranscript[0]).toContain(`任务 ${taskId} 已完成，无法取消`);
    expect(await stub.status()).toMatchObject({ state: "completed" });
  });
});
