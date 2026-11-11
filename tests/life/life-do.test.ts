import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import type { SpendEntry } from "../../src/life/books";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const DAY_MS = 86_400_000;
const START = Date.UTC(2030, 0, 1, 9, 0, 0);

let now = START;

function life(name: string) {
  return env.LIFE.get(env.LIFE.idFromName(name));
}

function entry(overrides: Partial<SpendEntry> = {}): SpendEntry {
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
    usd: 1,
    priced: true,
    ...overrides,
  };
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
  setClockOverride(null);
});

describe("LifeDO", () => {
  it("reports an empty ledger as ample and not started", async () => {
    const stub = life("life-empty");

    expect(await stub.vitals()).toEqual({
      balanceUsd: 0,
      dailySpendUsd: 0,
      runwayDays: null,
      tier: "ample",
      metabolismStarted: false,
      unpriced: false,
      topSources: [],
    });
  });

  it("derives balance, daily spend and runway from the books", async () => {
    const stub = life("life-runway");
    await stub.recordCredit(20, "");
    for (let day = 0; day < 7; day += 1) {
      now = START + Math.round((day + 0.5) * DAY_MS);
      await stub.recordSpend(entry());
    }
    now = START + 7 * DAY_MS;

    expect(await stub.vitals()).toMatchObject({
      balanceUsd: 13,
      dailySpendUsd: 1,
      runwayDays: 13,
      tier: "lean",
    });
  });

  it("records a call id only once", async () => {
    const stub = life("life-duplicate");
    await stub.recordCredit(20, "");
    await stub.recordSpend(entry({ callId: "call-1", usd: 2 }));
    await stub.recordSpend(entry({ callId: "call-1", usd: 2 }));

    expect((await stub.vitals()).balanceUsd).toBe(18);
  });

  it("counts spend older than the window in the balance only", async () => {
    const stub = life("life-old-spend");
    await stub.recordCredit(20, "");
    now = START - 8 * DAY_MS;
    await stub.recordSpend(entry({ usd: 4 }));
    now = START;

    expect(await stub.vitals()).toMatchObject({
      balanceUsd: 16,
      dailySpendUsd: 0,
    });
  });

  it("flags unpriced calls inside the window", async () => {
    const stub = life("life-unpriced");
    now = START - DAY_MS;
    await stub.recordSpend(entry({ priced: false, usd: 0 }));
    now = START;

    expect((await stub.vitals()).unpriced).toBe(true);
  });

  it("ignores unpriced calls older than the window", async () => {
    const stub = life("life-unpriced-old");
    now = START - 8 * DAY_MS;
    await stub.recordSpend(entry({ priced: false, usd: 0 }));
    now = START;

    expect((await stub.vitals()).unpriced).toBe(false);
  });

  it("groups the top three spend sources in the window", async () => {
    const stub = life("life-sources");
    now = START - DAY_MS;
    await stub.recordSpend(entry({ source: "butler", usd: 1 }));
    await stub.recordSpend(entry({ source: "butler", usd: 2 }));
    await stub.recordSpend(entry({ source: "task:t1", usd: 5 }));
    await stub.recordSpend(entry({ source: "bot:b1", usd: 3.5 }));
    await stub.recordSpend(entry({ source: "bot-chat:c1", usd: 0.5 }));
    await stub.recordSpend(
      entry({ at: START - 8 * DAY_MS, source: "task:t0", usd: 100 }),
    );
    now = START;

    expect((await stub.vitals()).topSources).toEqual([
      { source: "task:t1", usd: 5 },
      { source: "bot:b1", usd: 3.5 },
      { source: "butler", usd: 3 },
    ]);
  });

  it("calibrates the balance with an adjustment row", async () => {
    const stub = life("life-calibrate");
    await stub.recordCredit(20, "");
    await stub.recordSpend(entry({ usd: 7 }));

    expect((await stub.calibrate(2, "")).balanceUsd).toBe(2);
    expect((await stub.vitals()).balanceUsd).toBe(2);
  });

  it("starts the metabolism when the first row is a calibration", async () => {
    const stub = life("life-calibrate-empty");

    const vitals = await stub.calibrate(5, "");

    expect(vitals).toMatchObject({
      balanceUsd: 5,
      metabolismStarted: true,
    });
  });
});
