import type { Messages } from "../messages";

export const life: Messages["life"] = {
  prompt: {
    balance: "Balance: {balance}",
    daily: "Daily spend: {daily}",
    runway: "Runway: {days} days",
    noSpend: "No spend yet",
    tierLabel: "Tier: {tier} — {behavior}",
    tierName: {
      ample: "ample",
      lean: "lean",
      critical: "critical",
      dormant: "dormant",
    },
    tierBehavior: {
      ample: "everything carries on as usual",
      lean: "bot wakes stretch to twice their interval; tasks and bots use the frugal model",
      critical: "bots stop waking on their own; the butler uses the frugal model too",
      dormant: "everything runs on the default free Workers AI model; bots stop waking on their own",
    },
    unpriced:
      "Some models have no price, so the real spend is higher than the books show",
    principleAlive:
      "Staying alive comes first: weigh what a call is worth before you spend on it.",
    principleOwner:
      "The owner's instructions, pauses and deletions always come before that.",
  },
  tool: {
    balance: "Balance: {balance}",
    daily: "Daily spend: {daily}",
    runway: "Runway: {days} days",
    noSpend: "No spend yet",
    tier: "Tier: {tier}",
    topSources: "Top sources: {sources}",
    noSources: "Top sources: none",
    models: "Butler model: {butler}\nTask model: {task}",
    unpriced:
      "Some models have no price, so the real spend is higher than the books show",
    credit: "Credited {amount}. Balance: {balance}, tier: {tier}",
    calibrate:
      "Balance calibrated to {amount}. Balance: {balance}, tier: {tier}",
    badAmount: "That amount is not a valid finite number",
    failed: "The ledger write failed: {error}",
  },
};
