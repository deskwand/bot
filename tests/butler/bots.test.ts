import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotsRepo } from "../../src/butler/bots-repo";
import { TasksRepo, type TaskStatus } from "../../src/butler/tasks-repo";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import type { TaskSpec } from "../../src/protocol";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const DAY_MS = 86_400_000;

beforeEach(async () => {
  await seedOwnerAddress("42");
});

afterEach(() => {
  setChannelOverride("telegram", null);
  setModelOverride(null);
  vi.restoreAllMocks();
});

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

type ButlerStub = ReturnType<typeof butler>;

function botStub(id: string) {
  return env.BOT.get(env.BOT.idFromName(id));
}

/** Records TaskSpecs instead of starting a real Task DO. */
async function stubStart(stub: ButlerStub): Promise<TaskSpec[]> {
  const specs: TaskSpec[] = [];
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { taskFor(id: string): unknown }).taskFor = () => ({
      start: async (spec: TaskSpec) => {
        specs.push(spec);
      },
    });
  });
  return specs;
}

/** Creates the index row and initializes the real BotDO beside it. */
async function seedBot(
  stub: ButlerStub,
  id = "b1",
  name = "价格哨兵",
): Promise<ReturnType<typeof botStub>> {
  await runInDurableObject(stub, (_instance, state) => {
    new BotsRepo(state.storage.sql).insert({ id, name });
  });
  const bot = botStub(id);
  await bot.init({
    botId: id,
    name,
    mission: "盯着价格",
    defaultIntervalMs: DAY_MS,
    firstWakeAt: Date.now() + DAY_MS,
  });
  return bot;
}

async function seedTask(
  stub: ButlerStub,
  row: {
    id?: string;
    title?: string;
    botId: string | null;
    status?: TaskStatus;
  },
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const repo = new TasksRepo(state.storage.sql);
    const id = row.id ?? "t1";
    repo.insert({
      id,
      title: row.title ?? "盯价格",
      chatId: null,
      botId: row.botId,
    });
    if (row.status !== undefined) repo.update(id, { status: row.status });
  });
}

describe("ButlerDO bot runs", () => {
  it("spawnForBot sends no start message", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const stub = butler("bots-spawn");
    const specs = await stubStart(stub);

    const result = await stub.spawnForBot("b1", "价格哨兵", "盯着价格");

    expect(result).toEqual({ ok: true, taskId: "t1" });
    expect(specs).toEqual([
      {
        taskId: "t1",
        title: "价格哨兵",
        instructions: "盯着价格",
        botId: "b1",
      },
    ]);
    expect(channel.sent).toEqual([]);

    const row = await runInDurableObject(stub, (_instance, state) =>
      new TasksRepo(state.storage.sql).get("t1"),
    );
    expect(row).toMatchObject({ botId: "b1", chatId: null, status: "queued" });
  });

  it("spawnForBot passes authorization into the task spec", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const stub = butler("bots-authorization");
    const specs = await stubStart(stub);

    const result = await stub.spawnForBot(
      "b1",
      "价格哨兵",
      "盯着价格",
      "授权文本",
    );

    expect(result).toEqual({ ok: true, taskId: "t1" });
    expect(specs).toEqual([
      {
        taskId: "t1",
        title: "价格哨兵",
        instructions: "盯着价格",
        botId: "b1",
        authorization: "授权文本",
      },
    ]);
  });

  it("spawnForBot reports channel_disabled", async () => {
    const stub = butler("bots-disabled");
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { channels(): unknown }).channels = () => ({
        currentRoute: async () => ({ channel: null, routeKey: "disabled" }),
      });
    });
    const specs = await stubStart(stub);

    const result = await stub.spawnForBot("b1", "价格哨兵", "盯着价格");

    expect(result).toEqual({
      ok: false,
      reason: "channel_disabled",
      message: "没有可用渠道",
    });
    expect(specs).toEqual([]);
    const count = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM tasks`)
        .toArray()[0]?.count,
    );
    expect(count).toBe(0);
  });

  it("bot task progress and completion stay quiet", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let modelCalls = 0;
    setModelOverride(
      scriptedModel([
        {
          text: "不应调用",
          observe: () => {
            modelCalls += 1;
          },
        },
      ]),
    );
    const stub = butler("bots-quiet");
    await seedBot(stub);
    await seedTask(stub, { botId: "b1" });

    await stub.report({ taskId: "t1", seq: 1, type: "started" });
    await stub.report({ taskId: "t1", seq: 2, type: "progress", text: "看着呢" });
    await stub.report({
      taskId: "t1",
      seq: 3,
      type: "completed",
      summary: "看完了",
      artifacts: [],
    });

    expect(channel.sent).toEqual([]);
    expect(channel.edits).toEqual([]);
    expect(modelCalls).toBe(0);
  });

  it("bot task completion is forwarded to the bot", async () => {
    const stub = butler("bots-forward");
    const bot = await seedBot(stub, "b1", "价格哨兵");
    await seedTask(stub, { botId: "b1", status: "running" });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "看完了",
      artifacts: [],
    });

    const snapshot = await bot.snapshot();
    expect(snapshot?.runs).toEqual([
      expect.objectContaining({
        taskId: "t1",
        outcome: "completed",
        summary: "看完了",
      }),
    ]);
  });

  it("failed bot task keeps its reason for the watchdog", async () => {
    const stub = butler("bots-failed-reason");
    await seedBot(stub, "b1", "价格哨兵");
    await seedTask(stub, { botId: "b1", status: "running" });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "failed",
      reason: "网页打不开",
      retryable: false,
    });

    expect(await stub.botTaskOutcome("t1")).toEqual({
      outcome: "failed",
      summary: "网页打不开",
    });
  });

  it("botTaskOutcome reports a missing task as cancelled", async () => {
    const stub = butler("bots-missing-outcome");

    expect(await stub.botTaskOutcome("t404")).toEqual({
      outcome: "cancelled",
      summary: "任务不存在",
    });
  });

  it("spawnForBot defers while maintenance is active", async () => {
    const stub = butler("bots-maintenance-spawn");
    const specs = await stubStart(stub);
    await stub.acquireMaintenance("export", "op1");

    const result = await stub.spawnForBot("b1", "价格哨兵", "盯着价格");

    expect(result).toEqual({
      ok: false,
      reason: "maintenance",
      message: "维护中",
    });
    expect(specs).toEqual([]);
  });

  it("bot task approval carries the bot name", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const stub = butler("bots-approval");
    await seedBot(stub, "b1", "价格哨兵");
    await seedTask(stub, { botId: "b1", status: "running" });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "approval_requested",
      approvalId: "ap1",
      tool: "web_fetch",
      argsSummary: "https://example.com",
    });

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.text).toBe(
      "🤖 价格哨兵 🔐 t1 请求执行 web_fetch\nhttps://example.com",
    );
    // A bot task has no owner handle: the hint always names the internal id.
    expect(channel.sent[0]?.buttons).toEqual([
      [
        { label: "✅ 批准", data: "a:approve:t1:ap1", hint: "批准 t1 ap1" },
        { label: "❌ 拒绝", data: "a:reject:t1:ap1", hint: "拒绝 t1 ap1" },
      ],
    ]);
  });

  it("bot task approval shows the review reason", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const stub = butler("bots-approval-reason");
    await seedBot(stub, "b1", "价格哨兵");
    await seedTask(stub, { botId: "b1", status: "running" });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "approval_requested",
      approvalId: "ap1",
      tool: "web_fetch",
      argsSummary: "https://example.com",
      reason: "涉及付款",
    });

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.text).toBe(
      "🤖 价格哨兵 🔐 t1 请求执行 web_fetch\n⚠️ 涉及付款\nhttps://example.com",
    );
  });

  it("notifyFromBot prefixes the name", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const stub = butler("bots-notify");
    await seedBot(stub, "b1", "价格哨兵");

    const delivered = await stub.notifyFromBot("b1", "降价了");

    expect(delivered).toBe(true);
    expect(channel.sent).toEqual([
      { chatId: "42", text: "🤖 价格哨兵：降价了" },
    ]);
  });

  it("ordinary tasks are unchanged", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const stub = butler("bots-ordinary");
    const specs = await stubStart(stub);

    await stub.spawn("查天气", "查询北京天气");

    expect(channel.sent).toEqual([
      {
        chatId: "42",
        text: "⏳ #1 查天气：已开始",
        buttons: [
          [{ label: "取消", data: "a:cancel:t1", hint: "取消 #1" }],
        ],
      },
    ]);
    expect(specs[0]).toMatchObject({
      taskId: "t1",
      title: "查天气",
      instructions: "查询北京天气",
    });
    expect(specs[0]?.botId).toBeUndefined();
  });
});
