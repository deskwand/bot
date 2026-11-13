/** The synthetic cron the front service feeds `main.scheduled()`. */
export const CRON = "* * * * *";

const MINUTE_MS = 60_000;

export type ScheduledTarget = {
  scheduled(options: { scheduledTime: Date; cron: string }): Promise<unknown>;
};

export type AlarmStorage = {
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
};

/** Start of the minute after `nowMs`; always strictly greater than `nowMs`. */
export function nextMinute(nowMs: number): number {
  return Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
}

/** Fires one tick, then schedules the next. Never throws. */
export async function runTick(
  target: ScheduledTarget,
  storage: AlarmStorage,
  nowMs: number,
): Promise<void> {
  try {
    await target.scheduled({ scheduledTime: new Date(nowMs), cron: CRON });
  } catch (error) {
    console.warn(
      "front: scheduled tick failed:",
      error instanceof Error ? error.constructor.name : "Error",
    );
  }
  await storage.setAlarm(nextMinute(nowMs));
}

/** Sets an alarm only when none is pending. */
export async function ensureTicker(
  storage: AlarmStorage,
  nowMs: number,
): Promise<void> {
  if ((await storage.getAlarm()) !== null) return;
  await storage.setAlarm(nextMinute(nowMs));
}

export type TickerState = { ensured: boolean };

/** Runs `ensure` once, remembering success; a failure leaves the flag unset. */
export async function ensureOnce(
  state: TickerState,
  ensure: () => Promise<unknown>,
): Promise<void> {
  if (state.ensured) return;
  await ensure();
  state.ensured = true;
}
