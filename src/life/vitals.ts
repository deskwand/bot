export type Tier = "ample" | "lean" | "critical" | "dormant";

export const AMPLE_DAYS = 14;
export const CRITICAL_DAYS = 3;
export const WINDOW_MS = 7 * 86_400_000;

const DAY_MS = 86_400_000;

export type VitalsInput = {
  now: number;
  creditTotalUsd: number;
  spendTotalUsd: number;
  spendWindowUsd: number;
  firstSpendAt: number | null;
  hasCredit: boolean;
  unpriced: boolean;
  topSources: { source: string; usd: number }[];
};

export type Vitals = {
  balanceUsd: number;
  dailySpendUsd: number;
  runwayDays: number | null;
  tier: Tier;
  metabolismStarted: boolean;
  unpriced: boolean;
  topSources: { source: string; usd: number }[];
};

function elapsedDays(now: number, firstSpendAt: number | null): number {
  if (firstSpendAt === null) {
    return 7;
  }
  const days = Math.ceil((now - firstSpendAt) / DAY_MS);
  return Math.min(7, Math.max(1, days));
}

export function computeVitals(input: VitalsInput): Vitals {
  const balanceUsd = input.creditTotalUsd - input.spendTotalUsd;
  const days = elapsedDays(input.now, input.firstSpendAt);
  const dailySpendUsd = input.spendWindowUsd / days;
  const runwayDays = dailySpendUsd > 0 ? balanceUsd / dailySpendUsd : null;

  let tier: Tier;
  if (!input.hasCredit) {
    tier = "ample";
  } else if (balanceUsd <= 0) {
    tier = "dormant";
  } else if (runwayDays === null || runwayDays >= AMPLE_DAYS) {
    tier = "ample";
  } else if (runwayDays >= CRITICAL_DAYS) {
    tier = "lean";
  } else {
    tier = "critical";
  }

  return {
    balanceUsd,
    dailySpendUsd,
    runwayDays,
    tier,
    metabolismStarted: input.hasCredit,
    unpriced: input.unpriced,
    topSources: input.topSources,
  };
}

/** ample=0 … dormant=3; larger is worse. */
export function tierRank(tier: Tier): number {
  switch (tier) {
    case "ample":
      return 0;
    case "lean":
      return 1;
    case "critical":
      return 2;
    case "dormant":
      return 3;
  }
}
