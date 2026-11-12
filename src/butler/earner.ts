import type { BotInit, BotSnapshot } from "../bot/bot-do";
import { t, type Locale } from "../i18n";
import type { BotsRepo } from "./bots-repo";
import type { BotControl } from "./bot-tools";
import { getClock } from "./notifier";

/** The earner wakes at most every four hours unless it schedules itself. */
export const EARNER_INTERVAL_MS = 14_400_000;

export type EnsureEarnerResult =
  | "created"
  | "exists"
  | "unconfigured"
  | "busy";

type EarnerBot = Pick<BotControl, "init" | "snapshot" | "destroy">;

export type EnsureEarnerDeps = {
  bots: BotsRepo;
  bot(id: string): EarnerBot;
  walletConfigured: boolean;
  locale: Locale;
  /** Re-checked synchronously just before the row is written. */
  allowed?: () => boolean;
};

/**
 * Makes sure the deployment has exactly one earner bot, creating it from the
 * locale's copy when none exists. A snapshot that throws aborts the round by
 * design: a partial scan cannot prove the earner is absent, so the next cron
 * tick retries.
 */
export async function ensureEarnerBot(
  deps: EnsureEarnerDeps,
): Promise<EnsureEarnerResult> {
  if (!deps.walletConfigured) return "unconfigured";

  for (const row of deps.bots.list()) {
    const snapshot: BotSnapshot | null = await deps.bot(row.id).snapshot();
    if (snapshot?.meta.earner === true) return "exists";
  }

  const name = t(deps.locale, "wallet.earner.name");
  const id = deps.bots.nextId();
  // No await from here to `insert`: a maintenance lease that started during
  // the scan must not let a restore run alongside a fresh earner.
  if (deps.allowed !== undefined && !deps.allowed()) return "busy";
  deps.bots.insert({ id, name });
  const spec: BotInit = {
    botId: id,
    name,
    mission: t(deps.locale, "wallet.earner.mission"),
    defaultIntervalMs: EARNER_INTERVAL_MS,
    firstWakeAt: getClock().now(),
    rules: t(deps.locale, "wallet.earner.rules"),
    earner: true,
  };
  try {
    await deps.bot(id).init(spec);
  } catch (error) {
    // `init` can commit inside the Bot DO and still fail over RPC. Destroying
    // first closes that window; if the destroy also fails, keep the row: an
    // index row pointing at a dead bot is safer than an unindexed live earner,
    // which the next scan would not find and the cron would duplicate.
    try {
      await deps.bot(id).destroy();
    } catch {
      throw error;
    }
    deps.bots.remove(id);
    throw error;
  }
  return "created";
}
