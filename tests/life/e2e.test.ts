import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  setBotButlerOverride,
  setBotTaskOverride,
  type BotButler,
  type SpawnForBotResult,
} from "../../src/bot/bot-do";
import { BotStore, type BotMeta } from "../../src/bot/bot-store";
import { DIET_RECHECK_MS, WATCHDOG_MS } from "../../src/bot/wake";
import { setClockOverride } from "../../src/butler/notifier";
import type { SpendEntry } from "../../src/life/books";
import { effectiveModelRef } from "../../src/life/diet";
import type { Tier } from "../../src/life/vitals";
import type { ModelRef, Role } from "../../src/llm/models";
import { WORKERS_AI_DEFAULT_MODEL_ID } from "../../src/llm/workers-ai";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const DAY_MS = 86_400_000;
const START = Date.UTC(2030, 0, 1, 9, 0, 0);

const provider = fauxProvider({
  provider: "e2e-diet",
  models: [
    { id: "large", contextWindow: 128000 },
    { id: "frugal", contextWindow: 128000 },
  ],
});

const workersAi = fauxProvider({
  provider: "workers-ai",
  models: [{ id: WORKERS_AI_DEFAULT_MODEL_ID, contextWindow: 128000 }],
});

const configured: ModelRef = { provider: "e2e-diet", id: "large" };
const frugal: ModelRef = { provider: "e2e-diet", id: "frugal" };
const workersAiRef: ModelRef = {
  provider: "workers-ai",
  id: WORKERS_AI_DEFAULT_MODEL_ID,
};

function modelsCollection(): Models {
  const models = createModels();
  models.setProvider(provider.provider);
  models.setProvider(workersAi.provider);
  return models;
}

function dietEnv(): Env {
  return {
    ...(env as unknown as Env),
    LIFE: {
      idFromName: () => env.LIFE.idFromName("global"),
      get: (id: DurableObjectId) => env.LIFE.get(id),
    },
    DESKWAND_CONFIG: {
      schemaVersion: 1,
      owner: { telegramUserIds: [] },
      models: {
        butler: configured,
        task: configured,
        frugal,
        customProviders: [
          {
            id: "e2e-diet",
            api: "openai-completions",
            baseUrl: "https://e2e.example.com/v1",
            models: [{ id: "large" }, { id: "frugal" }],
          },
        ],
      },
      mcpServers: [],
    },
    MODEL_KEY_E2E_DIET: "k",
    AI: { fetch: async () => new Response("") },
  } as unknown as Env;
}

let now = START;

function life() {
  return env.LIFE.get(env.LIFE.idFromName("global"));
}

function entry(usd: number): SpendEntry {
  return {
    callId: crypto.randomUUID(),
    at: now,
    source: "butler",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    usd,
    priced: true,
  };
}

type FakeState = {
  spawns: string[];
  outcome: { outcome: "completed" | "failed" | null; summary: string };
};

function fakeButler(): FakeState {
  const state: FakeState = {
    spawns: [],
    outcome: { outcome: null, summary: "" },
  };
  const butler: BotButler = {
    async spawnForBot(botId): Promise<SpawnForBotResult> {
      state.spawns.push(botId);
      return { ok: true, taskId: `t${state.spawns.length}` };
    },
    async botTaskOutcome() {
      return state.outcome;
    },
    async botNotice() {},
    async ownerProfile() {
      return "";
    },
    async maintenanceActive() {
      return false;
    },
  };
  setBotButlerOverride(butler);
  return state;
}

type BotStub = ReturnType<typeof botStub>;

function botStub(id: string) {
  return env.BOT.get(env.BOT.idFromName(id));
}

async function fireAlarm(bot: BotStub): Promise<void> {
  expect(await runDurableObjectAlarm(bot)).toBe(true);
}

async function patchMeta(
  bot: BotStub,
  patch: Partial<BotMeta>,
): Promise<void> {
  await runInDurableObject(bot, (_instance, state) => {
    const store = new BotStore(state.storage.sql);
    const meta = store.readMeta();
    if (meta !== null) store.writeMeta({ ...meta, ...patch });
  });
}

async function effectiveFor(role: Role): Promise<ModelRef> {
  return effectiveModelRef(dietEnv(), modelsCollection(), role, configured);
}

beforeEach(() => {
  now = START;
  setClockOverride({
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  setBotButlerOverride(null);
  setBotTaskOverride(null);
  setClockOverride(null);
});

describe("life metabolism end to end", () => {
  it("walks from ample through lean, critical and dormant, then back", async () => {
    const stub = life();
    const notices: { tier: Tier; runwayDays: number | null }[] = [];
    try {
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("DELETE FROM spend");
        state.storage.sql.exec("DELETE FROM credit");
        return state.storage.kv.delete("notified_tier");
      });
      await runInDurableObject(stub, (instance) => {
        instance.notifyTierChange = async (tier, runwayDays) => {
          notices.push({ tier, runwayDays });
        };
      });

      const fake = fakeButler();
      const bot = botStub("e2e-life-bot");
      await bot.init({
        botId: "e2e-life-bot",
        name: "价格哨兵",
        mission: "盯着价格",
        defaultIntervalMs: DAY_MS,
        firstWakeAt: now,
      });

      // 1. No credit yet: ample, both roles on the configured model, bot runs.
      expect((await stub.vitals()).tier).toBe("ample");
      expect(await effectiveFor("task")).toEqual(configured);
      expect(await effectiveFor("butler")).toEqual(configured);

      await fireAlarm(bot);
      expect(fake.spawns).toHaveLength(1);
      fake.outcome = { outcome: "completed", summary: "看完了" };
      now += WATCHDOG_MS;
      await fireAlarm(bot);
      expect((await bot.snapshot())?.meta.currentTaskId).toBeNull();
      expect(notices).toEqual([]);
      const base = now;

      // 2. Credit 20 and spend $2 a day: lean.
      await stub.recordCredit(20, "");
      now = base + Math.round(0.5 * DAY_MS);
      await stub.recordSpend(entry(2));
      expect((await stub.vitals()).tier).toBe("lean");
      expect(await effectiveFor("task")).toEqual(frugal);
      expect(await effectiveFor("butler")).toEqual(configured);

      now = base + DAY_MS;
      await fireAlarm(bot);
      expect(fake.spawns).toHaveLength(2);
      now = base + DAY_MS + Math.round(0.5 * DAY_MS);
      await stub.recordSpend(entry(2));
      fake.outcome = { outcome: "completed", summary: "看完了" };
      now = base + DAY_MS + WATCHDOG_MS;
      await fireAlarm(bot);
      const afterLean = await bot.snapshot();
      expect(afterLean!.meta.currentTaskId).toBeNull();
      expect(afterLean!.meta.nextWakeAt! - now).toBe(2 * DAY_MS);
      expect(notices.map((notice) => notice.tier)).toEqual(["lean"]);

      // 3. Spend down under three days: critical, bot held.
      now = base + 2 * DAY_MS;
      await stub.recordSpend(entry(7));
      expect((await stub.vitals()).tier).toBe("critical");
      expect(await effectiveFor("task")).toEqual(frugal);
      expect(await effectiveFor("butler")).toEqual(frugal);

      await patchMeta(bot, { nextWakeAt: now });
      const spawnsBeforeHold = fake.spawns.length;
      await fireAlarm(bot);
      expect(fake.spawns).toHaveLength(spawnsBeforeHold);
      expect((await bot.snapshot())!.meta.nextWakeAt).toBe(
        now + DIET_RECHECK_MS,
      );
      expect(notices.map((notice) => notice.tier)).toEqual([
        "lean",
        "critical",
      ]);

      // 4. Spend the books to zero: dormant, bot still held.
      now = base + 2.5 * DAY_MS;
      await stub.recordSpend(entry(10));
      expect((await stub.vitals()).tier).toBe("dormant");
      expect(await effectiveFor("task")).toEqual(workersAiRef);
      expect(await effectiveFor("butler")).toEqual(workersAiRef);

      await fireAlarm(bot);
      expect(fake.spawns).toHaveLength(spawnsBeforeHold);
      expect((await bot.snapshot())!.meta.nextWakeAt).toBe(
        now + DIET_RECHECK_MS,
      );
      expect(notices.map((notice) => notice.tier)).toEqual([
        "lean",
        "critical",
        "dormant",
      ]);

      // 5. The owner credits 100: ample again and the held bot wakes.
      now = base + 2.5 * DAY_MS + DIET_RECHECK_MS;
      await stub.recordCredit(100, "");
      expect((await stub.vitals()).tier).toBe("ample");
      expect(await effectiveFor("task")).toEqual(configured);
      expect(await effectiveFor("butler")).toEqual(configured);

      await fireAlarm(bot);
      expect(fake.spawns).toHaveLength(spawnsBeforeHold + 1);
      expect(notices.map((notice) => notice.tier)).toEqual([
        "lean",
        "critical",
        "dormant",
        "ample",
      ]);
    } finally {
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("DELETE FROM spend");
        state.storage.sql.exec("DELETE FROM credit");
        return state.storage.kv.delete("notified_tier");
      });
    }
  });
});
