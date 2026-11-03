import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotStore } from "../../src/bot/bot-store";
import { BotsRepo } from "../../src/butler/bots-repo";
import {
  createBotTools,
  type TaskControl,
} from "../../src/butler/bot-tools";
import { setClockOverride } from "../../src/butler/notifier";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const START = Date.UTC(2030, 0, 1, 9, 0, 0);
const MINUTE = 60_000;

let now = START;

beforeEach(() => {
  now = START;
  setClockOverride({
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  setClockOverride(null);
  vi.restoreAllMocks();
});

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function botStub(id: string) {
  return env.BOT.get(env.BOT.idFromName(id));
}

/** A TaskControl that only records the calls the bot tools make. */
function fakeTask(calls: string[]): TaskControl {
  return {
    start: async () => {},
    status: async () => ({ state: "running", title: "" }),
    steer: async (text) => {
      calls.push(`steer:${text}`);
      return { ok: true, message: "" };
    },
    cancel: async () => {
      calls.push("cancel");
      return { ok: true, message: "" };
    },
    retryTask: async () => ({ ok: true, message: "" }),
    pendingApprovals: async () => [],
  };
}

/** Runs one bot tool inside the Butler object, like `createBotTools` is used. */
async function runTool(
  name: string,
  args: Record<string, unknown>,
  calls: string[] = [],
  butlerName = "bot-tools",
): Promise<{ text: string; rows: { id: string; name: string }[] }> {
  return runInDurableObject(
    butler(butlerName),
    async (_instance, state) => {
      const bots = new BotsRepo(state.storage.sql);
      const tools = createBotTools({
        bots,
        bot: (id) => botStub(id),
        task: () => fakeTask(calls),
      });
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`missing tool ${name}`);
      const outcome = await tool.execute(
        args as never,
        {} as never,
        {} as never,
      );
      return {
        text: (outcome.output?.[0] as { text: string }).text,
        rows: bots.list(),
      };
    },
  );
}

/** Puts the Bot DO in the middle of a run, as if an alarm had spawned one. */
async function setRunningTask(id: string, taskId: string): Promise<void> {
  await runInDurableObject(botStub(id), (_instance, state) => {
    const store = new BotStore(state.storage.sql);
    const meta = store.readMeta();
    if (meta === null) throw new Error("missing bot");
    meta.currentTaskId = taskId;
    store.writeMeta(meta);
  });
}

describe("butler bot tools", () => {
  it("create_bot rejects a bad interval", async () => {
    const result = await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "abc",
      },
      [],
      "bot-tools-bad-interval",
    );

    expect(result.text).toBe("时长格式无效：abc（示例：30m、2h、1d）");
    expect(result.rows).toEqual([]);
  });

  it("create_bot creates index row and bot", async () => {
    const result = await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
        first_wake_after: "30m",
      },
      [],
      "bot-tools-create",
    );

    const firstWakeAt = START + 30 * MINUTE;
    expect(result.text).toBe(
      `已创建机器人 b1 价格哨兵，首次唤醒：${new Date(firstWakeAt).toISOString()}`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ id: "b1", name: "价格哨兵" });

    const snapshot = await botStub("b1").snapshot();
    expect(snapshot?.meta).toMatchObject({
      botId: "b1",
      name: "价格哨兵",
      mission: "盯着价格",
      status: "active",
      defaultIntervalMs: 2 * 60 * MINUTE,
      nextWakeAt: firstWakeAt,
    });
  });

  it("steer_bot also steers the running task", async () => {
    const calls: string[] = [];
    await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
      },
      calls,
      "bot-tools-steer",
    );
    await setRunningTask("b1", "t1");

    const result = await runTool(
      "steer_bot",
      { id: "b1", text: "降价到 200 再提醒" },
      calls,
      "bot-tools-steer",
    );

    expect(result.text).toBe("已记录对 b1 的指令");
    expect(calls).toEqual(["steer:降价到 200 再提醒"]);
    expect((await botStub("b1").snapshot())?.meta.pendingSteer).toEqual([
      "降价到 200 再提醒",
    ]);
  });

  it("delete_bot cancels the run and empties the bot", async () => {
    const calls: string[] = [];
    await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
      },
      calls,
      "bot-tools-delete",
    );
    await setRunningTask("b1", "t1");

    const deleted = await runTool(
      "delete_bot",
      { id: "b1" },
      calls,
      "bot-tools-delete",
    );

    expect(deleted.text).toBe("已删除机器人 b1");
    expect(calls).toEqual(["cancel"]);
    expect(deleted.rows).toEqual([]);
    expect(await botStub("b1").snapshot()).toBeNull();

    const listed = await runTool(
      "list_bots",
      {},
      calls,
      "bot-tools-delete",
    );
    expect(listed.text).toBe("没有机器人");
  });

  it("list_bots shows a self-paused bot as paused", async () => {
    await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
      },
      [],
      "bot-tools-paused",
    );
    await botStub("b1").pause();

    const result = await runTool("list_bots", {}, [], "bot-tools-paused");

    expect(result.text).toBe("b1 [paused] 价格哨兵 下次：—");
  });
});
