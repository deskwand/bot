import { t, type Locale, type MessageKey } from "../i18n";
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
export function lifeBlock(locale: Locale, vitals: Vitals | null): string {
  if (vitals === null || !vitals.metabolismStarted) return "";

  const wholeDays = vitals.runwayDays === null
    ? null
    : Math.floor(vitals.runwayDays);
  const lines = [
    t(locale, "life.prompt.tierLabel", {
      tier: tierName(locale, vitals.tier),
      behavior: t(locale, TIER_BEHAVIOR[vitals.tier]),
    }),
    t(locale, "life.prompt.balance", {
      balance: wholeUsd(vitals.balanceUsd),
    }),
    vitals.runwayDays === null
      ? t(locale, "life.prompt.noSpend")
      : wholeDays !== null && wholeDays < 1
        ? t(locale, "life.prompt.runwayBelowDay")
        : t(locale, "life.prompt.runway", { days: wholeDays }),
  ];
  if (vitals.unpriced) lines.push(t(locale, "life.prompt.unpriced"));
  lines.push(t(locale, "life.prompt.principleAlive"));
  lines.push(t(locale, "life.prompt.principleOwner"));
  return lines.join("\n");
}
