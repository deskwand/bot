import type { PiHarness } from "agents/harness/pi";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/butler/memory";
import { setClockOverride } from "../../src/butler/notifier";
import { TasksRepo } from "../../src/butler/tasks-repo";
import { createButlerTools, SpawnFailedError } from "../../src/butler/tools";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import type { AdmittedMessage, RouteSnapshot, TaskSpec } from "../../src/protocol";
import { fakeChannel } from "../helpers/fake-channel";
import { seedOwnerAddress } from "../helpers/channel-ref";
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
], { contextWindow: 1_000_000 });

beforeEach(async () => {
  await seedOwnerAddress("42");
  route = await channels().currentRoute();
});

afterEach(() => {
  setClockOverride(null);
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
            liveness: async () => ({ state: "running", reattached: false }),
            pendingApprovals: async () => [],
          }),
          spawn: async () => {
            throw new SpawnFailedError("t1", "boom");
          },
          resolveAttachment: async () => null,
          memory: new MemoryStore(state.storage.sql),
          createSchedule: async () => "s1",
          listSchedules: () => [],
          removeSchedule: async () => false,
          lookup: async () => ({ ok: false }),
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

  it("passes resolved attachments to spawn", async () => {
    const result = await runInDurableObject(
      butler("tools-attachments"),
      async (_instance, state) => {
        const repo = new TasksRepo(state.storage.sql);
        const file = {
          name: "a.pdf",
          key: "inbox/tg:1/a.pdf",
          mimeType: "application/pdf",
          size: 3,
        };
        const captured: { attachments?: typeof file[] } = {};
        const tools = createButlerTools({
          repo,
          task: () => ({
            start: async () => {},
            status: async () => ({ state: "queued", title: "" }),
            steer: async () => ({ ok: false, message: "" }),
            cancel: async () => ({ ok: false, message: "" }),
            retryTask: async () => ({ ok: false, message: "" }),
            liveness: async () => ({ state: "running", reattached: false }),
            pendingApprovals: async () => [],
          }),
          spawn: async (_title, _instructions, attachments) => {
            captured.attachments = attachments;
            return "t1";
          },
          resolveAttachment: async (key) => (key === file.key ? file : null),
          memory: new MemoryStore(state.storage.sql),
          createSchedule: async () => "s1",
          listSchedules: () => [],
          removeSchedule: async () => false,
          lookup: async () => ({ ok: false }),
        });

        const spawnTask = tools.find((tool) => tool.name === "spawn_task");
        await spawnTask!.execute(
          {
            title: "t",
            instructions: "i",
            attachments: ["inbox/tg:1/a.pdf"],
          } as never,
          {} as never,
          {} as never,
        );

        return captured.attachments;
      },
    );

    expect(result).toEqual([
      {
        name: "a.pdf",
        key: "inbox/tg:1/a.pdf",
        mimeType: "application/pdf",
        size: 3,
      },
    ]);
  });

  it("resolves a duplicated attachment key once", async () => {
    const result = await runInDurableObject(
      butler("tools-attachments-deduped"),
      async (_instance, state) => {
        const repo = new TasksRepo(state.storage.sql);
        const file = {
          name: "a.pdf",
          key: "inbox/tg:1/a.pdf",
          mimeType: "application/pdf",
          size: 3,
        };
        const resolved: string[] = [];
        const captured: { attachments?: (typeof file)[] } = {};
        const tools = createButlerTools({
          repo,
          task: () => ({
            start: async () => {},
            status: async () => ({ state: "queued", title: "" }),
            steer: async () => ({ ok: false, message: "" }),
            cancel: async () => ({ ok: false, message: "" }),
            retryTask: async () => ({ ok: false, message: "" }),
            liveness: async () => ({ state: "running", reattached: false }),
            pendingApprovals: async () => [],
          }),
          spawn: async (_title, _instructions, attachments) => {
            captured.attachments = attachments;
            return "t1";
          },
          resolveAttachment: async (key) => {
            resolved.push(key);
            return key === file.key ? file : null;
          },
          memory: new MemoryStore(state.storage.sql),
          createSchedule: async () => "s1",
          listSchedules: () => [],
          removeSchedule: async () => false,
          lookup: async () => ({ ok: false }),
        });

        const spawnTask = tools.find((tool) => tool.name === "spawn_task");
        await spawnTask!.execute(
          {
            title: "t",
            instructions: "i",
            attachments: [file.key, file.key],
          } as never,
          {} as never,
          {} as never,
        );

        return { resolved, attachments: captured.attachments };
      },
    );

    expect(result.resolved).toEqual(["inbox/tg:1/a.pdf"]);
    expect(result.attachments).toHaveLength(1);
  });

  it("rejects an attachment key outside the inbox", async () => {
    const result = await runInDurableObject(
      butler("tools-attachment-outside"),
      async (_instance, state) => {
        const repo = new TasksRepo(state.storage.sql);
        let spawnCalls = 0;
        const tools = createButlerTools({
          repo,
          task: () => ({
            start: async () => {},
            status: async () => ({ state: "queued", title: "" }),
            steer: async () => ({ ok: false, message: "" }),
            cancel: async () => ({ ok: false, message: "" }),
            retryTask: async () => ({ ok: false, message: "" }),
            liveness: async () => ({ state: "running", reattached: false }),
            pendingApprovals: async () => [],
          }),
          spawn: async () => {
            spawnCalls += 1;
            return "t1";
          },
          resolveAttachment: async (key) =>
            key.startsWith("inbox/")
              ? {
                  name: "a.pdf",
                  key,
                  mimeType: "application/pdf",
                  size: 3,
                }
              : null,
          memory: new MemoryStore(state.storage.sql),
          createSchedule: async () => "s1",
          listSchedules: () => [],
          removeSchedule: async () => false,
          lookup: async () => ({ ok: false }),
        });

        const spawnTask = tools.find((tool) => tool.name === "spawn_task");
        const outcome = await spawnTask!.execute(
          {
            title: "t",
            instructions: "i",
            attachments: ["t9/x/secret.md"],
          } as never,
          {} as never,
          {} as never,
        );

        return {
          text: (outcome.output?.[0] as { text: string }).text,
          spawnCalls,
        };
      },
    );

    expect(result.text).toContain("附件不存在");
    expect(result.spawnCalls).toBe(0);
  });

  it("rejects an attachment that does not exist", async () => {
    const result = await runInDurableObject(
      butler("tools-attachment-missing"),
      async (_instance, state) => {
        const repo = new TasksRepo(state.storage.sql);
        let spawnCalls = 0;
        const tools = createButlerTools({
          repo,
          task: () => ({
            start: async () => {},
            status: async () => ({ state: "queued", title: "" }),
            steer: async () => ({ ok: false, message: "" }),
            cancel: async () => ({ ok: false, message: "" }),
            retryTask: async () => ({ ok: false, message: "" }),
            liveness: async () => ({ state: "running", reattached: false }),
            pendingApprovals: async () => [],
          }),
          spawn: async () => {
            spawnCalls += 1;
            return "t1";
          },
          resolveAttachment: async () => null,
          memory: new MemoryStore(state.storage.sql),
          createSchedule: async () => "s1",
          listSchedules: () => [],
          removeSchedule: async () => false,
          lookup: async () => ({ ok: false }),
        });

        const spawnTask = tools.find((tool) => tool.name === "spawn_task");
        const outcome = await spawnTask!.execute(
          {
            title: "t",
            instructions: "i",
            attachments: ["inbox/tg:1/missing.pdf"],
          } as never,
          {} as never,
          {} as never,
        );

        return {
          text: (outcome.output?.[0] as { text: string }).text,
          spawnCalls,
        };
      },
    );

    expect(result.text).toContain("附件不存在");
    expect(result.spawnCalls).toBe(0);
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
            liveness: async () => ({ state: "running", reattached: false }),
            pendingApprovals: async () => [],
          }),
          spawn: async () => "t2",
          resolveAttachment: async () => null,
          memory: new MemoryStore(state.storage.sql),
          createSchedule: async () => "s1",
          listSchedules: () => [],
          removeSchedule: async () => false,
          lookup: async () => ({ ok: false }),
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

  it("shows the last tool progress and how long ago it was", async () => {
    const now = 1_000_000;
    setClockOverride({
      now: () => now,
      setTimeout: () => 1,
      clearTimeout: () => {},
    });

    const result = await runInDurableObject(
      butler("tools-get-progress"),
      async (instance, state) => {
        const repo = new TasksRepo(state.storage.sql);
        repo.insert({ id: "t1", title: "查机票", chatId: "42" });
        repo.update("t1", {
          status: "running",
          lastProgress: "正在搜索 机票",
          lastProgressAt: now - 120_000,
        });
        (
          instance as unknown as { taskFor(id: string): unknown }
        ).taskFor = () => ({
          status: async () => ({ state: "running", title: "查机票" }),
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
        return (outcome.output?.[0] as { text: string }).text;
      },
    );

    expect(result).toContain("进度：正在搜索 机票（2 分钟前）");
  });

  it("keeps spawn quiet even when the Task DO reports progress immediately", async () => {
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
      status: "queued",
      lastProgress: "早期进度",
    });
    expect(channel.sent).toEqual([]);
    expect(channel.edits).toEqual([]);
  });

  it("fails a task without touching the chat when the Task DO cannot start", async () => {
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
    expect(channel.sent).toEqual([]);
    expect(channel.edits).toEqual([]);
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

    // Let the completion report settle before replacing the global test model.
    // Reports now apply the same model-switch guard as inbound chat.
    await vi.waitFor(() => runInDurableObject(butler("owner"), (instance) =>
      (instance as unknown as { harness: PiHarness }).harness.wait(`task-completed:${taskId}`),
    ));
    setModelOverride(cancelModel);

    await butler("owner").handleMessage(
      message({ text: "取消 t-done", eventId: "tg:202" }),
    );

    expect(channel.sent.at(-1)).toEqual({ chatId: "42", text: "ok" });
    expect(cancelTranscript[0]).toContain(`任务 ${taskId} 已完成，无法取消`);
    expect(await stub.status()).toMatchObject({ state: "completed" });
  });

  it("answers from quick_lookup without a replay", async () => {
    const result = await runInDurableObject(
      butler("tools-quick-lookup"),
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
            liveness: async () => ({ state: "running", reattached: false }),
            pendingApprovals: async () => [],
          }),
          spawn: async () => "t1",
          resolveAttachment: async () => null,
          memory: new MemoryStore(state.storage.sql),
          createSchedule: async () => "s1",
          listSchedules: () => [],
          removeSchedule: async () => false,
          lookup: async () => ({ ok: true, answer: "晴" }),
        });

        const tool = tools.find((entry) => entry.name === "quick_lookup");
        const outcome = await tool!.execute(
          { question: "上海天气", queries: ["上海 天气"] } as never,
          {} as never,
          {} as never,
        );
        return {
          text: (outcome.output?.[0] as { text: string }).text,
          replay: tool!.replay,
        };
      },
    );

    expect(result).toEqual({ text: "晴", replay: undefined });
  });

  it("registers the owner's life tools", async () => {
    const names = await runInDurableObject(
      butler("tools-life-registry"),
      (instance) =>
        instance.registry
          .snapshot()
          .tools()
          .map(({ tool }) => tool.name),
    );

    expect(names).toEqual(
      expect.arrayContaining([
        "life_vitals",
        "life_credit",
        "life_calibrate",
      ]),
    );
  });

  it("tells the model to spawn a task when quick_lookup finds nothing", async () => {
    const result = await runInDurableObject(
      butler("tools-quick-lookup-empty"),
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
            liveness: async () => ({ state: "running", reattached: false }),
            pendingApprovals: async () => [],
          }),
          spawn: async () => "t1",
          resolveAttachment: async () => null,
          memory: new MemoryStore(state.storage.sql),
          createSchedule: async () => "s1",
          listSchedules: () => [],
          removeSchedule: async () => false,
          lookup: async () => ({ ok: false }),
        });

        const tool = tools.find((entry) => entry.name === "quick_lookup");
        const outcome = await tool!.execute(
          { question: "上海天气", queries: ["上海 天气"] } as never,
          {} as never,
          {} as never,
        );
        return {
          text: (outcome.output?.[0] as { text: string }).text,
          isError: outcome.isError,
        };
      },
    );

    expect(result).toEqual({
      text: "快查没有结果，改用 spawn_task",
      isError: true,
    });
  });
});
