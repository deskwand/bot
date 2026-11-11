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
  notice: {
    ample:
      "{runway}. The deployment is back to the ample tier; everything carries on as usual.",
    lean: "{runway}. The deployment moved to the lean tier: bot wakes stretch to twice their interval, and tasks and bots use the frugal model.",
    critical:
      "{runway}. The deployment moved to the critical tier: bots stop waking on their own, and the butler uses the frugal model too.",
    dormant:
      "The balance is down to zero. The deployment is dormant: everything runs on the default free Workers AI model, and bots stop waking on their own.",
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
