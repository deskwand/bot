import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { setClockOverride } from "../../src/butler/notifier";
import type { SpendEntry } from "../../src/life/books";
import { readTier } from "../../src/life/client";
import { effectiveModelRef, modelForTier } from "../../src/life/diet";
import type { Tier } from "../../src/life/vitals";
import type { ModelRef, Role } from "../../src/llm/models";
import { WORKERS_AI_DEFAULT_MODEL_ID } from "../../src/llm/workers-ai";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const DAY_MS = 86_400_000;
const START = Date.UTC(2030, 0, 1, 9, 0, 0);

const provider = fauxProvider({
  provider: "diet-test",
  models: [
    { id: "large", contextWindow: 128000 },
    { id: "frugal", contextWindow: 128000 },
    { id: "tiny", contextWindow: 16000 },
    { id: "roomy", contextWindow: 640000 },
  ],
});

const workersAi = fauxProvider({
  provider: "workers-ai",
  models: [{ id: WORKERS_AI_DEFAULT_MODEL_ID, contextWindow: 128000 }],
});

const configured: ModelRef = { provider: "diet-test", id: "large" };
const frugal: ModelRef = { provider: "diet-test", id: "frugal" };
const workersAiRef: ModelRef = {
  provider: "workers-ai",
  id: WORKERS_AI_DEFAULT_MODEL_ID,
};

function modelsCollection(withWorkersAi = false): Models {
  const models = createModels();
  models.setProvider(provider.provider);
  if (withWorkersAi) models.setProvider(workersAi.provider);
  return models;
}

function config(frugalRef: ModelRef | undefined = frugal): unknown {
  return {
    schemaVersion: 1,
    owner: { telegramUserIds: [] },
    models: {
      butler: configured,
      task: configured,
      ...(frugalRef === undefined ? {} : { frugal: frugalRef }),
      customProviders: [
        {
          id: "diet-test",
          api: "openai-completions",
          baseUrl: "https://diet.example.com/v1",
          models: [
            { id: "large" },
            { id: "frugal" },
            { id: "tiny" },
            { id: "roomy" },
          ],
        },
      ],
    },
    mcpServers: [],
  };
}

function testEnv(extra: Record<string, unknown> = {}): Env {
  const life = env.LIFE;
  return {
    ...(env as unknown as Env),
    LIFE: {
      idFromName: () => life.idFromName(lifeName),
      get: (id: DurableObjectId) => life.get(id),
    },
    DESKWAND_CONFIG: config(),
    MODEL_KEY_DIET_TEST: "k",
    ...extra,
  } as unknown as Env;
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

let now = START;
let lifeName = "";
let lifeCount = 0;

/** Credit 20 and spend it over seven days until the books reach `tier`. */
async function driveTo(tier: Tier): Promise<void> {
  if (tier === "ample") return;
  const stub = env.LIFE.get(env.LIFE.idFromName(lifeName));
  await stub.recordCredit(20, "");
  const daily = {
    lean: [1, 1, 1, 1, 1, 1, 1],
    critical: [2, 2, 2, 2, 2, 2, 7],
    dormant: [2, 2, 2, 2, 2, 2, 8],
  }[tier];
  for (let day = 0; day < daily.length; day += 1) {
    now = START + Math.round((day + 0.5) * DAY_MS);
    await stub.recordSpend(entry(daily[day]!));
  }
  now = START + 7 * DAY_MS;
}

beforeEach(() => {
  lifeCount += 1;
  lifeName = `diet-${lifeCount}`;
  now = START;
  setClockOverride({
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  setClockOverride(null);
});

describe("modelForTier", () => {
  const cases: [Tier, Role, ModelRef][] = [
    ["ample", "task", configured],
    ["ample", "butler", configured],
    ["lean", "task", frugal],
    ["lean", "butler", configured],
    ["critical", "task", frugal],
    ["critical", "butler", frugal],
    ["dormant", "task", workersAiRef],
    ["dormant", "butler", workersAiRef],
  ];

  for (const [tier, role, expected] of cases) {
    it(`picks ${expected.provider}/${expected.id} for ${role} when ${tier}`, () => {
      expect(modelForTier(tier, role, configured, frugal)).toEqual(expected);
    });
  }

  it.each([
    ["lean", "task"],
    ["lean", "butler"],
    ["critical", "task"],
    ["critical", "butler"],
  ] as [Tier, Role][])(
    "falls back to the configured model for %s %s without a frugal ref",
    (tier, role) => {
      expect(modelForTier(tier, role, configured, undefined)).toEqual(configured);
    },
  );
});

describe("effectiveModelRef", () => {
  it("keeps the configured model before any credit was recorded", async () => {
    expect(
      await effectiveModelRef(testEnv(), modelsCollection(), "task", configured),
    ).toEqual(configured);
  });

  it("returns the configured ref when the tier's candidate is the same model", async () => {
    await driveTo("lean");

    const sameEnv = testEnv({ DESKWAND_CONFIG: config(configured) });

    expect(
      await effectiveModelRef(sameEnv, modelsCollection(), "task", configured),
    ).toEqual(configured);
  });

  it("uses the frugal model for tasks when lean, without the configured level", async () => {
    await driveTo("lean");

    const withLevel: ModelRef = { ...configured, thinkingLevel: "high" };

    expect(
      await effectiveModelRef(testEnv(), modelsCollection(), "task", withLevel),
    ).toEqual(frugal);
  });

  it("keeps the configured model for the butler when lean", async () => {
    await driveTo("lean");

    expect(
      await effectiveModelRef(testEnv(), modelsCollection(), "butler", configured),
    ).toEqual(configured);
  });

  it("uses the frugal model for the butler when critical", async () => {
    await driveTo("critical");

    expect(
      await effectiveModelRef(
        testEnv(),
        modelsCollection(),
        "butler",
        configured,
      ),
    ).toEqual(frugal);
  });

  it("uses the free Workers AI model when dormant", async () => {
    await driveTo("dormant");

    const aiEnv = testEnv({
      AI: { fetch: async () => new Response("") },
    });

    expect(
      await effectiveModelRef(
        aiEnv,
        modelsCollection(true),
        "task",
        configured,
      ),
    ).toEqual(workersAiRef);
  });

  it("ignores a configured frugal ref when dormant", async () => {
    await driveTo("dormant");

    const aiEnv = testEnv({
      AI: { fetch: async () => new Response("") },
      DESKWAND_CONFIG: config({ provider: "diet-test", id: "tiny" }),
    });

    expect(
      await effectiveModelRef(
        aiEnv,
        modelsCollection(true),
        "butler",
        configured,
      ),
    ).toEqual(workersAiRef);
  });

  it("keeps the configured model when the frugal window is under a quarter", async () => {
    await driveTo("lean");

    const smallEnv = testEnv({
      DESKWAND_CONFIG: config({ provider: "diet-test", id: "tiny" }),
    });

    expect(
      await effectiveModelRef(smallEnv, modelsCollection(), "task", configured),
    ).toEqual(configured);
  });

  it("keeps the configured model when active has five times the candidate's window", async () => {
    await driveTo("lean");

    expect(
      await effectiveModelRef(testEnv(), modelsCollection(), "task", configured, {
        provider: "diet-test",
        id: "roomy",
      }),
    ).toEqual(configured);
  });

  it("keeps the configured model when the frugal model does not exist", async () => {
    await driveTo("lean");

    const missingEnv = testEnv({
      DESKWAND_CONFIG: config({ provider: "deepseek", id: "missing" }),
    });

    expect(
      await effectiveModelRef(missingEnv, modelsCollection(), "task", configured),
    ).toEqual(configured);
  });

  it("keeps the configured model when the life ledger cannot be read", async () => {
    const brokenEnv = {
      DESKWAND_CONFIG: config(),
      MODEL_KEY_DIET_TEST: "k",
      LIFE: {
        idFromName: () => "life-id",
        get: () => ({
          vitals: async () => {
            throw new Error("life down");
          },
        }),
      },
    } as unknown as Env;

    expect(
      await effectiveModelRef(brokenEnv, modelsCollection(), "task", configured),
    ).toEqual(configured);
  });

  it("keeps the configured model when the configuration cannot be read", async () => {
    await driveTo("lean");

    const noConfig = {
      ...(testEnv() as unknown as Record<string, unknown>),
      DESKWAND_CONFIG: undefined,
    } as Env;

    expect(
      await effectiveModelRef(noConfig, modelsCollection(), "task", configured),
    ).toEqual(configured);
    expect(await readTier(noConfig)).toBe("lean");
  });
});
