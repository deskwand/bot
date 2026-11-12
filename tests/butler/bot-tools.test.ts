import { env, runInDurableObject } from "cloudflare:test";
import { Type } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotChatInput } from "../../src/bot/bot-chat-do";
import { RULES_LIMIT } from "../../src/bot/docs";
import { BotStore } from "../../src/bot/bot-store";
import { BotsRepo } from "../../src/butler/bots-repo";
import {
  createBotTools,
  type BotControl,
  type BotToolDeps,
  type TaskControl,
} from "../../src/butler/bot-tools";
import { setClockOverride } from "../../src/butler/notifier";
import { t, type Locale } from "../../src/i18n";

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
    liveness: async () => ({ state: "running", reattached: false }),
    pendingApprovals: async () => [],
  };
}

/** A BotControl stand-in that records calls instead of touching a Bot DO. */
function recordingBot(calls: string[]): BotControl {
  return new Proxy({} as BotControl, {
    get(_target, property) {
      return async (...args: unknown[]) => {
        calls.push(`${String(property)}:${JSON.stringify(args)}`);
        return null;
      };
    },
  });
}

/** Runs one bot tool inside the Butler object, like `createBotTools` is used. */
async function runTool(
  name: string,
  args: Record<string, unknown>,
  calls: string[] = [],
  butlerName = "bot-tools",
  botOverride?: BotControl,
  destroyChat?: (id: string) => Promise<void>,
  ask?: (id: string, input: BotChatInput) => Promise<string>,
  deps: Pick<BotToolDeps, "walletConfigured" | "locale"> = {},
): Promise<{
  text: string;
  isError: boolean;
  rows: { id: string; name: string }[];
  parameters: unknown;
  description: string;
}> {
  return runInDurableObject(
    butler(butlerName),
    async (_instance, state) => {
      const bots = new BotsRepo(state.storage.sql);
      const tools = createBotTools({
        bots,
        bot: (id) => botOverride ?? botStub(id),
        botChat: (id) => ({
          destroy: () => destroyChat?.(id) ?? Promise.resolve(),
          ask: (input) => ask?.(id, input) ?? Promise.resolve(""),
        }),
        task: () => fakeTask(calls),
        ...deps,
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
        isError: outcome.isError === true,
        rows: bots.list(),
        parameters: tool.parameters,
        description: tool.description ?? "",
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

  it("create_bot caps the first wake at the interval", async () => {
    await botStub("b1").destroy();
    const result = await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "1h",
        first_wake_after: "3d",
      },
      [],
      "bot-tools-create-cap",
    );

    const firstWakeAt = START + 3_600_000;
    expect(result.text).toBe(
      `已创建机器人 b1 价格哨兵，首次唤醒：${new Date(firstWakeAt).toISOString()}`,
    );
    expect((await botStub("b1").snapshot())?.meta.nextWakeAt).toBe(firstWakeAt);
  });

  it("set_bot_interval rejects a bad interval", async () => {
    await botStub("b1").destroy();
    await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
      },
      [],
      "bot-tools-set-interval-bad",
    );
    const calls: string[] = [];
    const fake = recordingBot(calls);

    const badFormat = await runTool(
      "set_bot_interval",
      { id: "b1", interval: "abc" },
      [],
      "bot-tools-set-interval-bad",
      fake,
    );
    const tooShort = await runTool(
      "set_bot_interval",
      { id: "b1", interval: "1m" },
      [],
      "bot-tools-set-interval-bad",
      fake,
    );

    expect(badFormat.text).toContain("时长");
    expect(tooShort.text).toContain("时长");
    expect(calls).toEqual([]);
    expect((await botStub("b1").snapshot())?.meta.defaultIntervalMs).toBe(
      2 * 3_600_000,
    );
  });

  it("set_bot_interval reports the new cadence", async () => {
    await botStub("b1").destroy();
    await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
        first_wake_after: "3h",
      },
      [],
      "bot-tools-set-interval",
    );

    const result = await runTool(
      "set_bot_interval",
      { id: "b1", interval: "1h" },
      [],
      "bot-tools-set-interval",
    );

    const nextWakeAt = START + 3_600_000;
    expect(result.text).toBe(
      `已将 b1 的默认间隔改为 1h，下次唤醒：${new Date(nextWakeAt).toISOString()}`,
    );
    expect((await botStub("b1").snapshot())?.meta.defaultIntervalMs).toBe(
      3_600_000,
    );
  });

  it("set_bot_interval reports an unknown id", async () => {
    const result = await runTool(
      "set_bot_interval",
      { id: "b9", interval: "1h" },
      [],
      "bot-tools-set-interval-missing",
    );

    expect(result.text).toBe("没有机器人 b9");
  });

  it("create_bot writes the initial rules", async () => {
    await botStub("b1").destroy();
    const result = await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
        rules: "凌晨不发消息",
      },
      [],
      "bot-tools-create-rules",
    );

    expect(result.text).toContain("已创建机器人 b1");
    expect((await botStub("b1").snapshot())?.docs).toContainEqual({
      name: "守则",
      content: "凌晨不发消息",
    });
  });

  it("create_bot keeps the wallet-less schema and description unchanged", async () => {
    await botStub("b1").destroy();
    const expected = Type.Object({
      name: Type.String(),
      mission: Type.String(),
      default_interval: Type.String(),
      first_wake_after: Type.Optional(Type.String()),
      rules: Type.Optional(Type.String()),
    });

    const result = await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
      },
      [],
      "bot-tools-create-schema",
    );

    expect(JSON.stringify(result.parameters)).toBe(JSON.stringify(expected));
    expect(result.description).toBe(
      "Create a long-lived bot that keeps working on a recurring mission and wakes itself up.",
    );
    expect(
      (result.parameters as { properties: Record<string, unknown> }).properties,
    ).not.toHaveProperty("earner");
    expect(result.description).not.toContain("earner");
  });

  it("create_bot creates an earner with the default rules", async () => {
    await botStub("b1").destroy();
    const result = await runTool(
      "create_bot",
      {
        name: "谋生机器人",
        mission: "让钱包慢慢变多",
        default_interval: "4h",
        earner: true,
      },
      [],
      "bot-tools-create-earner",
      undefined,
      undefined,
      undefined,
      { walletConfigured: true, locale: "zh" },
    );

    expect(result.text).toContain("已创建机器人 b1");
    expect(
      (result.parameters as { properties: Record<string, unknown> }).properties,
    ).toHaveProperty("earner");
    const snapshot = await botStub("b1").snapshot();
    expect(snapshot?.meta.earner).toBe(true);
    expect(snapshot?.docs).toContainEqual({
      name: "守则",
      content: t("zh", "wallet.earner.defaultRules"),
    });
  });

  it("create_bot only has one earner at a time", async () => {
    await botStub("b1").destroy();
    await botStub("b2").destroy();
    const deps = { walletConfigured: true, locale: "zh" as Locale };
    await runTool(
      "create_bot",
      {
        name: "谋生机器人",
        mission: "让钱包慢慢变多",
        default_interval: "4h",
        earner: true,
      },
      [],
      "bot-tools-earner-unique",
      undefined,
      undefined,
      undefined,
      deps,
    );

    const second = await runTool(
      "create_bot",
      { name: "第二个", mission: "也来谋生", default_interval: "4h", earner: true },
      [],
      "bot-tools-earner-unique",
      undefined,
      undefined,
      undefined,
      deps,
    );

    expect(second.text).toBe(t("zh", "wallet.earner.exists"));
    expect(second.rows).toHaveLength(1);
    expect(await botStub("b2").snapshot()).toBeNull();
  });

  it("create_bot can make another earner after deleting the first", async () => {
    await botStub("b1").destroy();
    await botStub("b2").destroy();
    const deps = { walletConfigured: true, locale: "zh" as Locale };
    const input = {
      name: "谋生机器人",
      mission: "让钱包慢慢变多",
      default_interval: "4h",
      earner: true,
    };
    await runTool(
      "create_bot",
      input,
      [],
      "bot-tools-earner-recreate",
      undefined,
      undefined,
      undefined,
      deps,
    );
    const deleted = await runTool(
      "delete_bot",
      { id: "b1" },
      [],
      "bot-tools-earner-recreate",
    );
    expect(deleted.text).toBe("已删除机器人 b1");

    const again = await runTool(
      "create_bot",
      input,
      [],
      "bot-tools-earner-recreate",
      undefined,
      undefined,
      undefined,
      deps,
    );

    expect(again.text).toContain("已创建机器人 b2");
    expect((await botStub("b2").snapshot())?.meta.earner).toBe(true);
  });

  it("create_bot refuses when an existing snapshot fails", async () => {
    const failing = new Proxy({} as BotControl, {
      get(_target, property) {
        if (property === "snapshot") {
          return async () => {
            throw new Error("snapshot failed");
          };
        }
        return async () => null;
      },
    });
    const butlerName = "bot-tools-earner-snapshot-error";
    await runInDurableObject(butler(butlerName), (_instance, state) => {
      new BotsRepo(state.storage.sql).insert({ id: "b1", name: "旧机器人" });
    });

    const result = await runTool(
      "create_bot",
      { name: "谋生机器人", mission: "让钱包慢慢变多", default_interval: "4h", earner: true },
      [],
      butlerName,
      failing,
      undefined,
      undefined,
      { walletConfigured: true, locale: "zh" },
    );

    expect(result.text).not.toContain("已创建机器人");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ id: "b1", name: "旧机器人" });
  });

  it("keeps both default earner rulebooks within the rules limit", () => {
    for (const locale of ["zh", "en"] as Locale[]) {
      expect(
        t(locale, "wallet.earner.defaultRules").length,
      ).toBeLessThanOrEqual(RULES_LIMIT);
      expect(t(locale, "wallet.earner.exists")).not.toBe(
        `wallet.earner.exists`,
      );
    }
  });

  it("create_bot rejects over-limit rules before creating the bot", async () => {
    await botStub("b1").destroy();
    const result = await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
        rules: "x".repeat(2001),
      },
      [],
      "bot-tools-create-rules-long",
    );

    expect(result.text).toBe("超过上限：写入后 2001/2000 字，请先精简");
    expect(result.rows).toEqual([]);
    expect(await botStub("b1").snapshot()).toBeNull();
  });

  it("edit_bot_doc writes and deletes a document directly", async () => {
    await botStub("b1").destroy();
    await runTool(
      "create_bot",
      {
        name: "价格哨兵",
        mission: "盯着价格",
        default_interval: "2h",
      },
      [],
      "bot-tools-edit-doc",
    );

    const written = await runTool(
      "edit_bot_doc",
      { id: "b1", name: "守则", content: "每天只发一次" },
      [],
      "bot-tools-edit-doc",
    );
    expect(written.text).toContain("已写入「守则」");
    expect((await botStub("b1").snapshot())?.docs).toContainEqual({
      name: "守则",
      content: "每天只发一次",
    });

    const deleted = await runTool(
      "edit_bot_doc",
      { id: "b1", name: "守则", content: "  " },
      [],
      "bot-tools-edit-doc",
    );
    expect(deleted.text).toBe("已删除「守则」");
    expect((await botStub("b1").snapshot())?.docs).toEqual([]);
  });

  it("edit_bot_doc reports an unknown id", async () => {
    await botStub("b9").destroy();
    const result = await runTool(
      "edit_bot_doc",
      { id: "b9", name: "守则", content: "每天只发一次" },
      [],
      "bot-tools-edit-doc-missing",
    );

    expect(result.text).toBe("没有机器人 b9");
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
    const chatCalls: string[] = [];
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
      undefined,
      async (id) => {
        chatCalls.push(id);
      },
    );

    expect(deleted.text).toBe("已删除机器人 b1");
    expect(calls).toEqual(["cancel"]);
    expect(chatCalls).toEqual(["b1"]);
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

  it("delete_bot keeps going when the chat destroy fails", async () => {
    const calls: string[] = [];
    await runTool(
      "create_bot",
      { name: "早报", mission: "盯着新闻", default_interval: "2h" },
      calls,
      "bot-tools-delete-chat",
    );
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});

    const deleted = await runTool(
      "delete_bot",
      { id: "b1" },
      calls,
      "bot-tools-delete-chat",
      undefined,
      async () => {
        throw new Error("chat destroy failed");
      },
    );

    expect(deleted.text).toBe("已删除机器人 b1");
    expect(deleted.rows).toEqual([]);
    expect(failed).toHaveBeenCalled();
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

  it("ask_bot returns the bot's answer", async () => {
    await botStub("b1").destroy();
    await runTool(
      "create_bot",
      { name: "价格哨兵", mission: "盯着价格", default_interval: "2h" },
      [],
      "bot-tools-ask",
    );
    const chats: { id: string; input: BotChatInput }[] = [];

    const result = await runTool(
      "ask_bot",
      { id: "b1", text: "刚才的价格怎么了" },
      [],
      "bot-tools-ask",
      undefined,
      undefined,
      (id, input) => {
        chats.push({ id, input });
        return Promise.resolve("价格回落了");
      },
    );

    expect(result.text).toBe("价格回落了");
    expect(result.isError).toBe(false);
    expect(chats).toHaveLength(1);
    expect(chats[0]?.id).toBe("b1");
    expect(chats[0]?.input.botId).toBe("b1");
    expect(chats[0]?.input.text).toBe("刚才的价格怎么了");
    expect(chats[0]?.input.eventId.startsWith("ask_bot:")).toBe(true);
  });

  it("ask_bot reports a missing bot", async () => {
    let calls = 0;

    const result = await runTool(
      "ask_bot",
      { id: "b9", text: "刚才的价格怎么了" },
      [],
      "bot-tools-ask-missing",
      undefined,
      undefined,
      () => {
        calls += 1;
        return Promise.resolve("");
      },
    );

    expect(result.text).toBe("没有机器人 b9");
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
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
