import { describe, expect, it } from "vitest";
import {
  computeVitals,
  tierRank,
  type VitalsInput,
} from "../../src/life/vitals";

const DAY_MS = 86_400_000;

function base(overrides: Partial<VitalsInput> = {}): VitalsInput {
  return {
    now: 30 * DAY_MS,
    creditTotalUsd: 0,
    spendTotalUsd: 0,
    spendWindowUsd: 0,
    firstSpendAt: 0,
    hasCredit: true,
    unpriced: false,
    topSources: [],
    ...overrides,
  };
}

describe("computeVitals", () => {
  it("computes balance, daily spend and runway", () => {
    expect(
      computeVitals(
        base({ creditTotalUsd: 20, spendTotalUsd: 6, spendWindowUsd: 7 }),
      ),
    ).toMatchObject({
      balanceUsd: 14,
      dailySpendUsd: 1,
      runwayDays: 14,
      tier: "ample",
    });
  });

  it("tiers by runway: 14 days is ample, 3 days is lean", () => {
    expect(
      computeVitals(base({ creditTotalUsd: 13.99, spendWindowUsd: 7 })).tier,
    ).toBe("lean");
    expect(
      computeVitals(base({ creditTotalUsd: 3, spendWindowUsd: 7 })).tier,
    ).toBe("lean");
    expect(
      computeVitals(base({ creditTotalUsd: 2.99, spendWindowUsd: 7 })).tier,
    ).toBe("critical");
  });

  it("is dormant once the balance is gone", () => {
    expect(
      computeVitals(base({ creditTotalUsd: 5, spendTotalUsd: 5 })).tier,
    ).toBe("dormant");
    expect(
      computeVitals(base({ creditTotalUsd: 5, spendTotalUsd: 9 })),
    ).toMatchObject({ balanceUsd: -4, tier: "dormant" });
  });

  it("is ample with no spend in the window", () => {
    expect(computeVitals(base({ creditTotalUsd: 1 }))).toMatchObject({
      runwayDays: null,
      tier: "ample",
    });
  });

  it("stays ample before the metabolism has started", () => {
    expect(
      computeVitals(
        base({ hasCredit: false, spendTotalUsd: 50, spendWindowUsd: 50 }),
      ),
    ).toMatchObject({ tier: "ample", metabolismStarted: false });
  });

  it("divides by one day on the first day", () => {
    expect(
      computeVitals(
        base({
          now: 3_600_000,
          creditTotalUsd: 10,
          spendTotalUsd: 2,
          spendWindowUsd: 2,
        }),
      ),
    ).toMatchObject({
      dailySpendUsd: 2,
      runwayDays: 4,
      tier: "lean",
    });
  });

  it("uses the elapsed days within the 7-day window", () => {
    expect(
      computeVitals(base({ now: 3 * DAY_MS, spendWindowUsd: 6 }))
        .dailySpendUsd,
    ).toBe(2);
  });

  it("passes through unpriced, top sources and metabolism state", () => {
    const topSources = [{ source: "butler", usd: 3 }];
    expect(
      computeVitals(base({ unpriced: true, topSources })),
    ).toMatchObject({
      unpriced: true,
      topSources,
      metabolismStarted: true,
    });
  });
});

describe("tierRank", () => {
  it("orders tiers from best to worst", () => {
    expect(
      (["ample", "lean", "critical", "dormant"] as const).map(tierRank),
    ).toEqual([0, 1, 2, 3]);
  });
});
