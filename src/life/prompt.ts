import { getClock } from "../butler/notifier";
import { t, type Locale, type MessageKey } from "../i18n";
import type { QuotaSnapshot } from "../llm/quota";
import {
  providerLabel,
  quotaBand,
  remainingPercent,
  resetText,
  tightestWindow,
  windowName,
} from "./quota-format";
import type { Tier, Vitals } from "./vitals";

const TIER_NAME: Record<Tier, MessageKey> = {
  ample: "life.prompt.tierName.ample",
  lean: "life.prompt.tierName.lean",
  critical: "life.prompt.tierName.critical",
  dormant: "life.prompt.tierName.dormant",
};

const TIER_BEHAVIOR: Record<Tier, MessageKey> = {
  ample: "life.prompt.tierBehavior.ample",
  lean: "life.prompt.tierBehavior.lean",
  critical: "life.prompt.tierBehavior.critical",
  dormant: "life.prompt.tierBehavior.dormant",
};

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** One money format everywhere: `-$5.00`, `$0.00` for anything rounding to zero. */
export function formatUsd(amount: number): string {
  const fixed = usd(amount);
  if (fixed === "$-0.00") return "$0.00";
  return fixed.startsWith("$-") ? `-$${fixed.slice(2)}` : fixed;
}

/** Whole dollars, so a prompt block does not change with every cent. */
function wholeUsd(amount: number): string {
  const rounded = Math.round(amount);
  if (rounded === 0) return "$0";
  return rounded < 0 ? `-$${Math.abs(rounded)}` : `$${rounded}`;
}

/** The display name of a tier in `locale`. */
export function tierName(locale: Locale, tier: Tier): string {
  return t(locale, TIER_NAME[tier]);
}

/** The vitals block for a system prompt; "" when vitals is null or metabolism has not started. */
export function lifeBlock(
  locale: Locale,
  vitals: Vitals | null,
  walletValueUsd?: number | null,
  quota?: QuotaSnapshot | null,
): string {
  if (vitals === null || !vitals.metabolismStarted) return "";

  const lines = [
    t(locale, "life.prompt.tierLabel", {
      tier: tierName(locale, vitals.tier),
      behavior: t(locale, TIER_BEHAVIOR[vitals.tier]),
    }),
    t(locale, "life.prompt.balance", {
      balance: wholeUsd(vitals.balanceUsd),
    }),
  ];
  if (typeof walletValueUsd === "number") {
    lines.push(
      t(locale, "wallet.prompt.value", { value: wholeUsd(walletValueUsd) }),
    );
  }
  lines.push(
    vitals.runwayDays === null
      ? t(locale, "life.prompt.noSpend")
      : Math.floor(vitals.runwayDays) < 1
        ? t(locale, "life.prompt.runwayBelowDay")
        : t(locale, "life.prompt.runway", {
            days: Math.floor(vitals.runwayDays),
          }),
  );
  lines.push(...quotaLines(locale, quota));
  if (vitals.unpriced) lines.push(t(locale, "life.prompt.unpriced"));
  lines.push(t(locale, "life.prompt.principleAlive"));
  lines.push(t(locale, "life.prompt.principleOwner"));
  return lines.join("\n");
}

/**
 * One line per provider, naming the window that will throttle first. The
 * percent is rounded to five-point steps so the block does not change on every
 * call and invalidate the prompt prefix cache.
 */
function quotaLines(locale: Locale, quota?: QuotaSnapshot | null): string[] {
  if (quota === undefined || quota === null) return [];
  const now = getClock().now();
  const lines: string[] = [];
  for (const providerQuota of quota.providers) {
    const window = tightestWindow(providerQuota);
    if (window === undefined) continue;
    const remaining = Math.round(remainingPercent(window.usedPercent) / 5) * 5;
    const band = quotaBand(remaining);
    const params = {
      provider: providerLabel(providerQuota.provider),
      window: windowName(locale, window.key),
      band: t(locale, `life.quota.band.${band}` as MessageKey),
      percent: remaining,
      reset: resetText(locale, window.resetsAt, now),
    };
    lines.push(
      providerQuota.plan === undefined
        ? t(locale, "life.prompt.quota", params)
        : t(locale, "life.prompt.quotaWithPlan", {
            ...params,
            plan: providerQuota.plan,
          }),
    );
  }
  return lines;
}
