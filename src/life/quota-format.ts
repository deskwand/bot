/**
 * Presentation helpers shared by the prompt block and the `life_vitals` tool.
 * The prompt uses coarse bands so its text does not change on every call; the
 * tool uses the exact number.
 */
import { t, type Locale, type MessageKey } from "../i18n";
import {
  QUOTA_PROVIDER_LABELS,
  type ProviderQuota,
  type QuotaWindow,
  type QuotaWindowKey,
} from "../llm/quota";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const WINDOW_ORDER: Record<QuotaWindowKey, number> = {
  "5h": 0,
  week: 1,
  month: 2,
};

export type QuotaBand = "ample" | "lean" | "critical";

/** Whole percent left, clamped to 0..100. */
export function remainingPercent(usedPercent: number): number {
  return Math.min(100, Math.max(0, Math.round(100 - usedPercent)));
}

/** Coarse thresholds: 50% and 20% left. */
export function quotaBand(remaining: number): QuotaBand {
  if (remaining >= 50) return "ample";
  if (remaining >= 20) return "lean";
  return "critical";
}

/** The window that will throttle first. */
export function tightestWindow(quota: ProviderQuota): QuotaWindow | undefined {
  let tightest: QuotaWindow | undefined;
  for (const window of quota.windows) {
    if (
      tightest === undefined ||
      remainingPercent(window.usedPercent) <
        remainingPercent(tightest.usedPercent)
    ) {
      tightest = window;
    }
  }
  return tightest;
}

export function sortedWindows(quota: ProviderQuota): QuotaWindow[] {
  return [...quota.windows].sort(
    (left, right) => WINDOW_ORDER[left.key] - WINDOW_ORDER[right.key],
  );
}

export function windowName(locale: Locale, key: QuotaWindowKey): string {
  return t(locale, `life.quota.window.${key}` as MessageKey);
}

export function providerLabel(provider: string): string {
  return QUOTA_PROVIDER_LABELS[provider] ?? provider;
}

/** Relative by design: a deployment has no owner time zone to print. */
export function resetText(
  locale: Locale,
  resetsAt: number,
  now: number,
): string {
  const left = resetsAt - now;
  if (left <= 0) return t(locale, "life.quota.reset.now");
  if (left >= DAY_MS) {
    return t(locale, "life.quota.reset.days", {
      days: Math.round(left / DAY_MS),
    });
  }
  if (left >= HOUR_MS) {
    return t(locale, "life.quota.reset.hours", {
      hours: Math.round(left / HOUR_MS),
    });
  }
  return t(locale, "life.quota.reset.minutes", {
    minutes: Math.max(1, Math.round(left / 60_000)),
  });
}

export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
