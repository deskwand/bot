import { t, type Locale } from "../i18n";

export function botFinishedText(
  locale: Locale,
  reason: string | null | undefined,
): string {
  return t(locale, "bot.finished", {
    reason: reason ?? t(locale, "bot.finishReasonUnknown"),
  });
}

export function botDailyLimitText(
  locale: Locale,
  limit: number,
): string {
  return t(locale, "bot.dailyLimit", { limit });
}

export function botFailingText(
  locale: Locale,
  failures: number,
  reason: string,
  retryEvery: string,
): string {
  return t(locale, "bot.failing", { failures, reason, retryEvery });
}

export function botRecoveredText(locale: Locale): string {
  return t(locale, "bot.recovered");
}

export function botRunTimeoutText(locale: Locale): string {
  return t(locale, "bot.runTimeout");
}
