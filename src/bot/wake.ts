import type { Tier } from "../life/vitals";

/** How long a held bot waits before asking the tier again. */
export const DIET_RECHECK_MS = 3_600_000;

/** Shortest and longest interval a bot may schedule between wakes. */
export const MIN_WAKE_MS = 300_000;
export const MAX_WAKE_MS = 2_592_000_000;

/** How many wakes a bot may start in one UTC day, manual wakes included. */
export const DAILY_WAKE_LIMIT = 48;

/** Alarm interval while a run is in flight. */
export const WATCHDOG_MS = 3_600_000;

/** How long to wait before retrying when no channel is selected. */
export const CHANNEL_DISABLED_RETRY_MS = 3_600_000;

/** How far past its time an alarm may be before `heal()` treats it as lost. */
export const HEAL_OVERDUE_MS = 600_000;

/** How often the Butler's cron sweeps bots for lost or stale alarms. */
export const HEAL_INTERVAL_MS = 900_000;

/** Consecutive failed runs before a bot tells its owner it is failing. */
export const FAILING_NOTICE_AT = 3;

/** Longest a single run may stay in flight before the watchdog cancels it. */
export const RUN_MAX_MS = 86_400_000;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_RE = /^(?:\d+[mhd])+$/;

/**
 * Parses a duration such as `"90m"`, `"2h"` or `"1d12h"` into milliseconds.
 * Returns null for anything else so callers can report a Chinese error.
 */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  if (!DURATION_RE.test(trimmed)) return null;
  let total = 0;
  for (const match of trimmed.matchAll(/(\d+)([mhd])/g)) {
    const value = Number(match[1]);
    if (value === 0) return null;
    total += value * UNIT_MS[match[2]!]!;
  }
  return total;
}

/** The longest a bot's own schedule may stretch, given its cadence. */
export function wakeCeilingMs(defaultIntervalMs: number): number {
  return Math.min(MAX_WAKE_MS, defaultIntervalMs);
}

/** The longest gap `heal()` tolerates before calling an alarm stale. */
export function healCeilingMs(
  now: number,
  defaultIntervalMs: number,
  tier: Tier = "ample",
): number {
  const base =
    tier === "lean"
      ? Math.min(2 * defaultIntervalMs, MAX_WAKE_MS)
      : defaultIntervalMs;
  return Math.max(base, 21_600_000, nextUtcMidnight(now) - now);
}

/** Keeps a requested wake time inside the allowed window around `now`. */
export function clampWakeAt(
  now: number,
  at: number,
  maxMs: number = MAX_WAKE_MS,
): { at: number; clamped: boolean } {
  const min = now + MIN_WAKE_MS;
  const max = now + Math.max(MIN_WAKE_MS, Math.min(maxMs, MAX_WAKE_MS));
  if (at < min) return { at: min, clamped: true };
  if (at > max) return { at: max, clamped: true };
  return { at, clamped: false };
}

/** Whether a wake that is due should run. Manual wakes always run. */
export function dietHolds(
  tier: Tier,
  manual: boolean,
  earner = false,
): boolean {
  if (manual) return false;
  if (tier === "dormant") return true;
  return tier === "critical" && !earner;
}

/** Doubles the gap to the next wake while lean; otherwise returns `at`. */
export function stretchForDiet(now: number, at: number, tier: Tier): number {
  if (tier !== "lean") return at;
  return Math.min(now + 2 * (at - now), now + MAX_WAKE_MS);
}

/** Backoff: 15 minutes, 1 hour, then six hours or one default interval. */
export function failureDelayMs(
  consecutiveFailures: number,
  defaultIntervalMs: number,
): number {
  if (consecutiveFailures <= 1) return 900_000;
  if (consecutiveFailures === 2) return 3_600_000;
  return Math.max(21_600_000, defaultIntervalMs);
}

/** Renders a duration in the largest unit that divides it exactly. */
export function formatDuration(ms: number): string {
  if (ms >= UNIT_MS.d! && ms % UNIT_MS.d! === 0) {
    return `${ms / UNIT_MS.d!}d`;
  }
  if (ms >= UNIT_MS.h! && ms % UNIT_MS.h! === 0) {
    return `${ms / UNIT_MS.h!}h`;
  }
  return `${Math.round(ms / UNIT_MS.m!)}m`;
}

/** The UTC calendar day of a timestamp, as `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The first instant of the next UTC day. */
export function nextUtcMidnight(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000 + 86_400_000;
}
