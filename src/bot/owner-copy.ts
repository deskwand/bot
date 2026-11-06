import { t, type Locale } from "../i18n";

export function botFinishedText(
  locale: Locale,
  name: string,
  reason: string | null | undefined,
): string {
  return t(locale, "bot.finished", {
    name,
    reason: reason ?? t(locale, "bot.finishReasonUnknown"),
  });
}

export function botDailyLimitText(
  locale: Locale,
  name: string,
  limit: number,
): string {
  return t(locale, "bot.dailyLimit", { name, limit });
}

export function botFailingText(
  locale: Locale,
  name: string,
  failures: number,
  reason: string,
  retryEvery: string,
): string {
  return t(locale, "bot.failing", { name, failures, reason, retryEvery });
}

export function botRecoveredText(locale: Locale, name: string): string {
  return t(locale, "bot.recovered", { name });
}

export function botRunTimeoutText(locale: Locale): string {
  return t(locale, "bot.runTimeout");
}
