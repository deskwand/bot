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

/** The vitals block for a system prompt; "" when vitals is null or metabolism has not started. */
export function lifeBlock(locale: Locale, vitals: Vitals | null): string {
  if (vitals === null || !vitals.metabolismStarted) return "";

  const lines = [
    t(locale, "life.prompt.balance", { balance: usd(vitals.balanceUsd) }),
    t(locale, "life.prompt.daily", {
      daily: usd(vitals.dailySpendUsd),
    }),
    vitals.runwayDays === null
      ? t(locale, "life.prompt.noSpend")
      : t(locale, "life.prompt.runway", {
          days: vitals.runwayDays.toFixed(1),
        }),
    t(locale, "life.prompt.tierLabel", {
      tier: t(locale, TIER_NAME[vitals.tier]),
      behavior: t(locale, TIER_BEHAVIOR[vitals.tier]),
    }),
  ];
  if (vitals.unpriced) lines.push(t(locale, "life.prompt.unpriced"));
  lines.push(t(locale, "life.prompt.principleAlive"));
  lines.push(t(locale, "life.prompt.principleOwner"));
  return lines.join("\n");
}
