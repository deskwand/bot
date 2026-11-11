import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import { Books, type SpendEntry } from "../../src/life/books";
import type { Tier } from "../../src/life/vitals";

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

type Notice = { tier: Tier; runwayDays: number | null };

type LifeStub = ReturnType<typeof life>;

/** Replaces the instance's notice hook with a recorder. */
async function recordNotices(
  stub: LifeStub,
  notices: Notice[],
  options: { fail?: boolean } = {},
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    instance.notifyTierChange = async (tier, runwayDays) => {
      notices.push({ tier, runwayDays });
      if (options.fail === true) throw new Error("notice failed");
    };
  });
}

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
    now = START - 9 * DAY_MS;
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
    await stub.recordCredit(20, "");
    now = START - DAY_MS;
    await stub.recordSpend(entry({ priced: false, usd: 0 }));
    now = START;

    expect((await stub.vitals()).unpriced).toBe(true);
  });

  it("ignores unpriced calls older than the window", async () => {
    const stub = life("life-unpriced-old");
    await stub.recordCredit(20, "");
    now = START - 8 * DAY_MS;
    await stub.recordSpend(entry({ priced: false, usd: 0 }));
    now = START;

    expect((await stub.vitals()).unpriced).toBe(false);
  });

  it("groups the top three spend sources in the window", async () => {
    const stub = life("life-sources");
    await stub.recordCredit(20, "");
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
      { source: "task", usd: 5 },
      { source: "bot:b1", usd: 3.5 },
      { source: "butler", usd: 3 },
    ]);
  });

  it("starts the balance at the first credit", async () => {
    const stub = life("life-first-credit");
    for (let day = 0; day < 7; day += 1) {
      now = START - (7 - day) * DAY_MS + Math.round(0.5 * DAY_MS);
      await stub.recordSpend(entry({ usd: 90 / 7 }));
    }
    now = START;

    const credited = await stub.recordCredit(20, "");
    expect(credited).toMatchObject({
      balanceUsd: 20,
      metabolismStarted: true,
    });
    expect(credited.balanceUsd).toBe(20);

    now = START + 60_000;
    await stub.recordSpend(entry({ usd: 5 }));
    expect((await stub.vitals()).balanceUsd).toBe(15);
  });

  it("still rolls up spend before the first credit", async () => {
    const stub = life("life-uncredited-rollup");
    now = START - DAY_MS;
    await stub.recordSpend(entry({ source: "task:t1", usd: 2 }));
    now = START;

    expect(await stub.vitals()).toMatchObject({
      balanceUsd: 0,
      metabolismStarted: false,
      tier: "ample",
      topSources: [],
    });

    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ hour: number; source: string; usd: number; unpriced: number }>(
          `SELECT hour, source, usd, unpriced FROM spend_hourly`,
        )
        .toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "task", usd: 2, unpriced: 0 });
  });

  it("keeps totals and hourly rollups consistent after many spends", async () => {
    const stub = life("life-many-spends");
    await stub.recordCredit(20, "");

    await runInDurableObject(stub, async (instance) => {
      for (let index = 0; index < 1000; index += 1) {
        now = START + Math.floor(index / 100) * 3_600_000;
        await instance.recordSpend(
          entry({
            callId: `many-${index}`,
            at: now,
            source: index % 2 === 0 ? "butler" : "task:t1",
            usd: 0.01,
          }),
        );
      }
    });
    now = START + 10 * 3_600_000;

    expect((await stub.vitals()).balanceUsd).toBeCloseTo(10, 6);

    const ledger = await runInDurableObject(stub, (_instance, state) => {
      const totals = state.storage.sql
        .exec<{
          credit_usd: number;
          spend_usd: number;
          first_spend_at: number | null;
          first_credit_at: number | null;
        }>(
          `SELECT credit_usd, spend_usd, first_spend_at, first_credit_at FROM totals WHERE id = 1`,
        )
        .toArray()[0];
      const direct =
        state.storage.sql
          .exec<{ total: number }>(
            `SELECT COALESCE(SUM(usd), 0) AS total FROM spend
             WHERE at >= (SELECT first_credit_at FROM totals WHERE id = 1)`,
          )
          .toArray()[0]?.total ?? 0;
      const hourly =
        state.storage.sql
          .exec<{ total: number }>(
            `SELECT COALESCE(SUM(usd), 0) AS total FROM spend_hourly`,
          )
          .toArray()[0]?.total ?? 0;
      const raw =
        state.storage.sql
          .exec<{ total: number }>(
            `SELECT COALESCE(SUM(usd), 0) AS total FROM spend`,
          )
          .toArray()[0]?.total ?? 0;
      return { totals, direct, hourly, raw };
    });

    expect(ledger.totals.credit_usd).toBe(20);
    expect(ledger.totals.spend_usd).toBeCloseTo(ledger.direct, 6);
    expect(ledger.hourly).toBeCloseTo(ledger.raw, 6);
  });

  it("rebuilds a missing totals row on the next construction", async () => {
    const stub = life("life-rebuild-totals");
    await stub.recordCredit(20, "");
    now = START + DAY_MS;
    await stub.recordSpend(entry({ source: "task:t1", usd: 3 }));
    await stub.recordSpend(entry({ source: "butler", usd: 2 }));
    now = START + DAY_MS + 60_000;

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM totals`);
      // The next construction finds no totals row and rebuilds it.
      new Books(state.storage.sql, (closure) =>
        state.storage.transactionSync(closure),
      );
    });
    now = START + DAY_MS + 3_600_000;

    expect((await stub.vitals()).balanceUsd).toBe(15);

    const rebuilt = await runInDurableObject(stub, (_instance, state) => ({
      totals: state.storage.sql
        .exec<{ spend_usd: number }>(
          `SELECT spend_usd FROM totals WHERE id = 1`,
        )
        .toArray()[0],
      hourly: state.storage.sql
        .exec<{ source: string; usd: number }>(
          `SELECT source, usd FROM spend_hourly ORDER BY source`,
        )
        .toArray(),
    }));
    expect(rebuilt.totals.spend_usd).toBe(5);
    expect(rebuilt.hourly).toEqual([
      { source: "butler", usd: 2 },
      { source: "task", usd: 3 },
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

describe("LifeDO tier notices", () => {
  it("says nothing before any credit was recorded", async () => {
    const stub = life("life-notice-uncredited");
    const notices: Notice[] = [];
    await recordNotices(stub, notices);

    for (let day = 0; day < 10; day += 1) {
      now = START + day * DAY_MS;
      await stub.recordSpend(entry({ usd: 5 }));
    }

    expect(notices).toEqual([]);
  });

  it("tells each worsening tier once and stops at dormant", async () => {
    const stub = life("life-notice-descent");
    const notices: Notice[] = [];
    await recordNotices(stub, notices);
    await stub.recordCredit(20, "");

    now = START + Math.round(0.5 * DAY_MS);
    await stub.recordSpend(entry({ usd: 2 }));
    expect(notices.map((notice) => notice.tier)).toEqual(["lean"]);

    for (const day of [1.5, 2.5, 3.5, 4.5, 5.5]) {
      now = START + Math.round(day * DAY_MS);
      await stub.recordSpend(entry({ usd: 2 }));
    }
    expect(notices.map((notice) => notice.tier)).toEqual(["lean"]);

    now = START + Math.round(6.5 * DAY_MS);
    await stub.recordSpend(entry({ usd: 2 }));
    expect(notices.map((notice) => notice.tier)).toEqual(["lean", "critical"]);

    now = START + Math.round(6.6 * DAY_MS);
    await stub.recordSpend(entry({ usd: 6 }));
    expect(notices.map((notice) => notice.tier)).toEqual([
      "lean",
      "critical",
      "dormant",
    ]);

    await stub.recordCredit(50, "");
    expect(notices.map((notice) => notice.tier)).toEqual([
      "lean",
      "critical",
      "dormant",
      "ample",
    ]);
  });

  it("stays quiet when a spend only returns to an already-noticed tier", async () => {
    const stub = life("life-notice-rebound");
    const notices: Notice[] = [];
    await recordNotices(stub, notices);
    await stub.recordCredit(20, "");

    now = START + Math.round(0.5 * DAY_MS);
    await stub.recordSpend(entry({ usd: 2 }));
    expect(notices.map((notice) => notice.tier)).toEqual(["lean"]);

    // The whole spend window slides out, so the books say ample again.
    now = START + 8 * DAY_MS;
    await stub.recordSpend(entry({ usd: 1 }));
    await stub.recordSpend(entry({ usd: 8 }));
    expect(notices.map((notice) => notice.tier)).toEqual(["lean"]);

    await stub.recordSpend(entry({ usd: 4 }));
    expect(notices.map((notice) => notice.tier)).toEqual(["lean", "critical"]);
  });

  it("records the spend even when the notice throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = life("life-notice-failure");
    const notices: Notice[] = [];
    await recordNotices(stub, notices, { fail: true });
    await stub.recordCredit(20, "");

    now = START + Math.round(0.5 * DAY_MS);
    await expect(
      stub.recordSpend(entry({ usd: 2 })),
    ).resolves.toBeUndefined();

    expect((await stub.vitals()).tier).toBe("lean");
    expect(notices.map((notice) => notice.tier)).toEqual(["lean"]);
    warn.mockRestore();
  });
});
