import type { EntryRecord } from "@earendil-works/pi-durable";

export const QUOTA_EXHAUSTED_TEXT =
  "今天的 Cloudflare 免费模型额度已用完（UTC 0 点重置，即北京时间 8 点）。想继续用，可以在桌面端模型页换成自己的模型 key。";

export const WORKERS_AI_QUOTA_MARKER = "WORKERS_AI_QUOTA_EXHAUSTED";

export const PAID_PLAN_REQUIRED_TEXT =
  "当前模型需要 Cloudflare Workers 付费计划，请在桌面端模型页换成免费计划可用的模型（例如默认的 Gemma 4 26B）。";

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
): string | undefined {
  if (marker === WORKERS_AI_QUOTA_MARKER) return QUOTA_EXHAUSTED_TEXT;
  if (marker === WORKERS_AI_PAID_PLAN_MARKER) return PAID_PLAN_REQUIRED_TEXT;
  return undefined;
}
