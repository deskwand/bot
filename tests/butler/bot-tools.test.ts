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

  it("get_bot shows rules, methods and memory", async () => {
    await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
      },
      [],
      "bot-tools-get",
    );
    const bot = botStub("b1");
    await bot.writeDoc("守则", "凌晨不发消息", { allowRules: true });
    await bot.writeDoc("方法A", "先看主站", { allowRules: false });
    await bot.writeDoc("记忆", "- 喜欢绿茶", { allowRules: false });

    const result = await runTool("get_bot", { id: "b1" }, [], "bot-tools-get");

    expect(result.text).toContain("守则：\n凌晨不发消息");
    expect(result.text).toContain("方法：\n- 方法A（4 字）");
    expect(result.text).toContain("记忆：\n- 喜欢绿茶");
  });

  it("get_bot shows 无 for empty document sections", async () => {
    // Bot DO names are shared across tests in this file, so start clean.
    await botStub("b1").destroy();
    await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
      },
      [],
      "bot-tools-get-empty",
    );

    const result = await runTool(
      "get_bot",
      { id: "b1" },
      [],
      "bot-tools-get-empty",
    );

    expect(result.text).toContain("守则：\n无\n方法：\n无\n记忆：\n无");
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

  it("wake_bot explains a run in flight", async () => {
    // Bot DO names are shared across tests in this file, so start clean.
    await botStub("b1").destroy();
    await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
      },
      [],
      "bot-tools-wake-running",
    );
    await setRunningTask("b1", "t1");

    const result = await runTool(
      "wake_bot",
      { id: "b1" },
      [],
      "bot-tools-wake-running",
    );

    expect(result.text).toBe("b1 正在运行，结束后约 5 分钟再唤醒");
  });

  it("wake_bot asks to resume a paused bot", async () => {
    // Bot DO names are shared across tests in this file, so start clean.
    await botStub("b1").destroy();
    await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
      },
      [],
      "bot-tools-wake-paused",
    );
    await botStub("b1").pause();

    const result = await runTool(
      "wake_bot",
      { id: "b1" },
      [],
      "bot-tools-wake-paused",
    );

    expect(result.text).toBe("b1 已暂停或已完成，先恢复再唤醒");
  });

  it("wake_bot schedules an idle bot", async () => {
    // Bot DO names are shared across tests in this file, so start clean.
    await botStub("b1").destroy();
    await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
      },
      [],
      "bot-tools-wake-idle",
    );

    const result = await runTool(
      "wake_bot",
      { id: "b1" },
      [],
      "bot-tools-wake-idle",
    );

    expect(result.text).toBe("已安排 b1 立即唤醒");
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

  it("rename_bot trims the name and updates both stores", async () => {
    // Bot DO names are shared across tests in this file, so start clean.
    await botStub("b1").destroy();
    await runTool(
      "create_bot",
      { name: "价格哨兵", mission: "盯着价格", default_interval: "2h" },
      [],
      "bot-tools-rename",
    );

    const result = await runTool(
      "rename_bot",
      { id: "b1", name: "  早报  " },
      [],
      "bot-tools-rename",
    );

    expect(result.text).toBe("已将 b1 改名为 早报");
    expect(result.rows).toEqual([
      { id: "b1", name: "早报", createdAt: expect.any(Number) },
    ]);

    const snapshot = await botStub("b1").snapshot();
    expect(snapshot?.meta).toMatchObject({ botId: "b1", name: "早报" });
  });

  it("rename_bot rejects a blank name", async () => {
    // Bot DO names are shared across tests in this file, so start clean.
    await botStub("b1").destroy();
    await runTool(
      "create_bot",
      { name: "价格哨兵", mission: "盯着价格", default_interval: "2h" },
      [],
      "bot-tools-rename-blank",
    );

    const result = await runTool(
      "rename_bot",
      { id: "b1", name: "   " },
      [],
      "bot-tools-rename-blank",
    );

    expect(result.text).toBe("名字不能为空");
    expect(result.rows[0]).toMatchObject({ id: "b1", name: "价格哨兵" });
    expect((await botStub("b1").snapshot())?.meta.name).toBe("价格哨兵");
  });

  it("rename_bot rejects a name with no visible characters", async () => {
    // Bot DO names are shared across tests in this file, so start clean.
    await botStub("b1").destroy();
    await runTool(
      "create_bot",
      { name: "价格哨兵", mission: "盯着价格", default_interval: "2h" },
      [],
      "bot-tools-rename-invisible",
    );

    const result = await runTool(
      "rename_bot",
      { id: "b1", name: "\u200b" },
      [],
      "bot-tools-rename-invisible",
    );

    expect(result.text).toBe("名字不能为空");
    expect(result.rows[0]).toMatchObject({ id: "b1", name: "价格哨兵" });
  });

  it("rename_bot reports a missing bot even when the index row survives", async () => {
    // Bot DO names are shared across tests in this file, so start clean.
    await botStub("b1").destroy();
    // A half-finished create can leave the index row without a BotDO meta.
    await runInDurableObject(
      butler("bot-tools-rename-orphan"),
      (_instance, state) => {
        new BotsRepo(state.storage.sql).insert({ id: "b1", name: "价格哨兵" });
      },
    );

    const result = await runTool(
      "rename_bot",
      { id: "b1", name: "早报" },
      [],
      "bot-tools-rename-orphan",
    );

    expect(result.text).toBe("没有机器人 b1");
    expect(result.rows[0]).toMatchObject({ id: "b1", name: "价格哨兵" });
  });

  it("rename_bot reports an unknown id", async () => {
    const result = await runTool(
      "rename_bot",
      { id: "b9", name: "早报" },
      [],
      "bot-tools-rename-missing",
    );

    expect(result.text).toBe("没有机器人 b9");
    expect(result.rows).toEqual([]);
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
