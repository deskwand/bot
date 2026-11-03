import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotsRepo } from "../../src/butler/bots-repo";
import { TasksRepo } from "../../src/butler/tasks-repo";
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
const TWO_HOURS_MS = 7_200_000;

beforeEach(async () => {
  await seedOwnerAddress("42");
});

afterEach(() => {
  setChannelOverride("telegram", null);
  setModelOverride(null);
  vi.restoreAllMocks();
});

function butler() {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

type BotStub = ReturnType<typeof botStub>;

function botStub(id: string) {
  return env.BOT.get(env.BOT.idFromName(id));
}

/** Creates the Butler's index row and the real BotDO behind it. */
async function seedBot(id: string, name = "价格哨兵"): Promise<BotStub> {
  await runInDurableObject(butler(), (_instance, state) => {
    new BotsRepo(state.storage.sql).insert({ id, name });
  });
  const bot = botStub(id);
  await bot.init({
    botId: id,
    name,
    mission: "盯着价格",
    defaultIntervalMs: DAY_MS,
    firstWakeAt: Date.now(),
  });
  return bot;
}

/** The first run writes memory, a note, a wake time and one notification. */
function firstRunModel() {
  return scriptedModel([
    { toolCalls: [{ name: "bot_remember", args: { content: "上次价格 239" } }] },
    { toolCalls: [{ name: "bot_note", args: { text: "明早再看" } }] },
    { toolCalls: [{ name: "set_next_wake", args: { after: "2h" } }] },
    { toolCalls: [{ name: "notify_owner", args: { text: "降价到 199" } }] },
    { toolCalls: [{ name: "finish_task", args: { summary: "看完了" } }] },
  ]);
}

async function runFirstRun(bot: BotStub): Promise<void> {
  await runDurableObjectAlarm(bot);
  await vi.waitFor(
    async () => {
      const snapshot = await bot.snapshot();
      expect(snapshot?.runs[0]?.outcome).toBe("completed");
      expect(snapshot?.meta.currentTaskId).toBeNull();
    },
    { timeout: 20_000 },
  );
}

async function alarmAt(bot: BotStub): Promise<number | null> {
  return runInDurableObject(bot, (_instance, state) =>
    state.storage.getAlarm(),
  );
}

/** Reads the spec a TaskDO persisted for itself. */
async function storedSpec(taskId: string): Promise<TaskSpec> {
  const stub = env.TASK.get(env.TASK.idFromName(taskId));
  const json = await runInDurableObject(stub, (_instance, state) => {
    return state.storage.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'spec'`)
      .toArray()[0]?.value;
  });
  return JSON.parse(json ?? "{}") as TaskSpec;
}

describe("bot run end to end", () => {
  it("a bot run writes memory and schedules itself", async () => {
    setChannelOverride("telegram", fakeChannel().adapter);
    setModelOverride(firstRunModel());
    const bot = await seedBot("e2e-b1");

    await runFirstRun(bot);

    const snapshot = await bot.snapshot();
    expect(snapshot?.memories).toHaveLength(1);
    expect(snapshot?.memories[0]?.content).toBe("上次价格 239");
    expect(snapshot?.runs).toHaveLength(1);
    expect(snapshot?.runs[0]).toMatchObject({
      outcome: "completed",
      note: "明早再看",
    });

    const endedAt = snapshot!.runs[0]!.endedAt!;
    const alarm = await alarmAt(bot);
    expect(alarm).toBeGreaterThanOrEqual(endedAt + TWO_HOURS_MS - 5_000);
    expect(alarm).toBeLessThanOrEqual(endedAt + TWO_HOURS_MS + 5_000);
  });

  it("the owner only sees the notification", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(firstRunModel());
    const bot = await seedBot("e2e-b2");

    await runFirstRun(bot);

    expect(channel.sent).toEqual([
      { chatId: "42", text: "🤖 价格哨兵：降价到 199" },
    ]);
    expect(channel.edits).toEqual([]);
  });

  it("the next run sees the memory", async () => {
    setChannelOverride("telegram", fakeChannel().adapter);
    setModelOverride(firstRunModel());
    const bot = await seedBot("e2e-b3");
    await runFirstRun(bot);

    setModelOverride(scriptedModel([{ text: "done" }]));
    // The first run scheduled a wake two hours out; pull it in for the test.
    await bot.wakeNow();
    const spec = await vi.waitFor(
      async () => {
        const rows = await runInDurableObject(butler(), (_instance, state) => {
          return new TasksRepo(state.storage.sql)
            .list()
            .filter((row) => row.botId === "e2e-b3");
        });
        expect(rows).toHaveLength(2);
        const stored = await storedSpec(rows[1]!.id);
        expect(stored.botId).toBe("e2e-b3");
        return stored;
      },
      { timeout: 20_000 },
    );

    expect(spec.instructions).toContain("上次价格 239");
    expect(spec.instructions).toContain("明早再看");
  });

  it("ordinary tasks get no bot tools", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
      ]),
    );
    setChannelOverride("telegram", fakeChannel().adapter);
    const stub = env.TASK.get(env.TASK.idFromName("e2e-ordinary"));

    await stub.start({
      taskId: "e2e-ordinary",
      title: "普通任务",
      instructions: "do the thing",
    });

    const tools = await runInDurableObject(stub, (instance) =>
      instance.registry
        .snapshot()
        .tools()
        .map((entry) => entry.tool.name),
    );
    expect(tools).not.toContain("bot_remember");
    expect(tools).toContain("finish_task");
  });
});
