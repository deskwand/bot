import type { EntryRecord } from "@earendil-works/pi-durable";
import { t, type Locale } from "../i18n";

export const QUOTA_EXHAUSTED_TEXT = t("zh", "llm.quotaExhausted");

export const WORKERS_AI_QUOTA_MARKER = "WORKERS_AI_QUOTA_EXHAUSTED";

export const PAID_PLAN_REQUIRED_TEXT = t("zh", "llm.paidPlanRequired");

export const WORKERS_AI_PAID_PLAN_MARKER = "WORKERS_AI_PAID_PLAN_REQUIRED";

const QUOTA_EXHAUSTED_PATTERN =
  /"internalCode"\s*:\s*4006\b|daily free allocation/i;

const PAID_PLAN_REQUIRED_PATTERN =
  /"internalCode"\s*:\s*5035\b|not available on the Workers Free plan/i;

export function isWorkersAiQuotaExhausted(rawProviderError: string): boolean {
  return QUOTA_EXHAUSTED_PATTERN.test(rawProviderError);
}

export function isWorkersAiPaidPlanRequired(
  rawProviderError: string,
): boolean {
  return PAID_PLAN_REQUIRED_PATTERN.test(rawProviderError);
}

export function quotaExhaustedText(locale: Locale): string {
  return t(locale, "llm.quotaExhausted");
}

export function paidPlanRequiredText(locale: Locale): string {
  return t(locale, "llm.paidPlanRequired");
}

/**
 * Whether a failed run's summary is the quota notice. Bots compare the text
 * they were handed, which is written in whatever locale was active then.
 */
export function isQuotaExhaustedSummary(summary: string): boolean {
  return summary === quotaExhaustedText("zh") || summary === quotaExhaustedText("en");
}

export function modelUnavailableText(
  locale: Locale,
  provider: string,
  id: string,
): string {
  return t(locale, "llm.modelUnavailable", { provider, id });
}

export function modelUnavailableShortText(
  locale: Locale,
  provider: string,
  id: string,
): string {
  return t(locale, "llm.modelUnavailableShort", { provider, id });
}

export function modelKeyMissingText(
  locale: Locale,
  provider: string,
  secret: string,
): string {
  return t(locale, "llm.modelKeyMissing", { provider, secret });
}

export function workersAiBindingUnavailableText(locale: Locale): string {
  return t(locale, "llm.bindingUnavailable");
}

/**
 * The model error of the newest assistant turn, if it failed. An older error
 * before a normal assistant reply is stale: pi recovered from it.
 */
export function lastModelError(
  entries: readonly EntryRecord[],
): string | undefined {
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const messages = entries[entryIndex]?.model;
    if (messages === undefined) continue;

    for (
      let messageIndex = messages.length - 1;
      messageIndex >= 0;
      messageIndex -= 1
    ) {
      const message = messages[messageIndex];
      if (message?.role !== "assistant") continue;
      return message.stopReason === "error" ? message.errorMessage : undefined;
    }
  }
  return undefined;
}

/** The user-facing explanation for a marker rewritten by the wrapper. */
export function userTextForModelError(
  marker: string | undefined,
  locale: Locale = "zh",
): string | undefined {
  if (marker === WORKERS_AI_QUOTA_MARKER) return quotaExhaustedText(locale);
  if (marker === WORKERS_AI_PAID_PLAN_MARKER) return paidPlanRequiredText(locale);
  return undefined;
}
