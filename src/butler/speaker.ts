import { t, tryT, type Locale, type MessageKey } from "../i18n";
import { phoneRules } from "../phone/style";
import { formatUsd } from "../life/prompt";
import { persona } from "./persona";
import type { Tier } from "../life/vitals";

/** One thing that happened and needs to reach the owner in the butler's voice. */
export type SpeakEvent =
  | { kind: "task.completed"; title: string; body: string }
  | { kind: "task.failed"; title: string; body: string; retryable: boolean }
  | { kind: "task.stalled"; title: string; body: string }
  | { kind: "task.slow"; title: string; body: string }
  | { kind: "bot.message"; botName: string; body: string }
  | { kind: "life.tier"; tier: Tier; runwayDays: number | null; body: "" }
  | {
      kind: "wallet.remit";
      id: string;
      usdc: number;
      shortUsd: number;
      txUrl: string;
      body: "";
    }
  | {
      kind: "wallet.remitFailed";
      usdc: number;
      reason: string;
      body: "";
    };

export type SpeakComplete = (
  system: string,
  user: string,
  signal: AbortSignal,
) => Promise<string>;

/** A stalled rewrite must not hold back the event forever. */
export const SPEAK_TIMEOUT_MS = 20_000;

/** Longest lead-in we keep when the body is forwarded verbatim. */
export const LEAD_MAX = 40;

/** Above this length the body is sent verbatim behind a one-line lead-in. */
export function rewriteLimit(locale: Locale): number {
  return locale === "en" ? 1200 : 600;
}

function bodyPresent(body: string): boolean {
  return body.trim() !== "";
}

const TIER_NOTICE: Record<Tier, MessageKey> = {
  ample: "life.notice.ample",
  lean: "life.notice.lean",
  critical: "life.notice.critical",
  dormant: "life.notice.dormant",
};

/** Text to send when the model cannot rewrite; never empty. */
export function fallbackText(event: SpeakEvent, locale: Locale): string {
  switch (event.kind) {
    case "task.completed":
      return bodyPresent(event.body)
        ? event.body
        : t(locale, "butler.speaker.completedEmpty", { title: event.title });
    case "task.failed": {
      const head = bodyPresent(event.body)
        ? t(locale, "butler.speaker.failedWith", {
            title: event.title,
            body: event.body,
          })
        : t(locale, "butler.speaker.failedEmpty", { title: event.title });
      return event.retryable
        ? `${head}\n${t(locale, "butler.speaker.retryQuestion")}`
        : head;
    }
    case "task.stalled":
      return bodyPresent(event.body)
        ? t(locale, "butler.speaker.stalledWith", {
            title: event.title,
            body: event.body,
          })
        : t(locale, "butler.speaker.stalledEmpty", { title: event.title });
    case "task.slow":
      return bodyPresent(event.body)
        ? t(locale, "butler.speaker.slowWith", {
            title: event.title,
            body: event.body,
          })
        : t(locale, "butler.speaker.slowEmpty", { title: event.title });
    case "bot.message":
      return t(locale, "butler.speaker.botMessage", {
        botName: event.botName,
        body: event.body,
      });
    case "life.tier": {
      const runway =
        event.runwayDays === null
          ? t(locale, "life.prompt.noSpend")
          : t(locale, "life.prompt.runway", {
              days: event.runwayDays.toFixed(1),
            });
      return t(locale, TIER_NOTICE[event.tier], { runway });
    }
    case "wallet.remit": {
      const head = t(locale, "wallet.notice.remit", {
        usdc: formatUsd(event.usdc),
        txUrl: event.txUrl,
        id: event.id,
      });
      return event.shortUsd > 0
        ? `${head}\n${t(locale, "wallet.notice.remitShort", {
            short: formatUsd(event.shortUsd),
          })}`
        : head;
    }
    case "wallet.remitFailed":
      return t(locale, "wallet.notice.failed", {
        usdc: formatUsd(event.usdc),
        reason: tryT(locale, event.reason) ?? event.reason,
      });
  }
}

const NUMBER = /\d[\d.,:%]*/g;
const URL = /https?:\/\/[^\s）)】>]+/g;

/** Facts the rewrite must copy verbatim: number strings and links. */
function facts(text: string): string[] {
  const numbers = Array.from(text.matchAll(NUMBER), (match) =>
    match[0].replace(/[.,:]+$/, ""),
  );
  const links = Array.from(text.matchAll(URL), (match) => match[0]);
  return [...numbers, ...links];
}

/** Number strings and links present in `source` but absent from `rewritten`. */
export function missingFacts(source: string, rewritten: string): string[] {
  return facts(source).filter((fact) => !rewritten.includes(fact));
}

function kindLabel(event: SpeakEvent, locale: Locale): string {
  switch (event.kind) {
    case "task.completed":
      return t(locale, "butler.speaker.kindCompleted");
    case "task.failed":
      return t(locale, "butler.speaker.kindFailed");
    case "task.stalled":
      return t(locale, "butler.speaker.kindStalled");
    case "task.slow":
      return t(locale, "butler.speaker.kindSlow");
    case "bot.message":
      return t(locale, "butler.speaker.kindBotMessage");
    case "life.tier":
      return t(locale, "butler.speaker.kindLifeTier");
    case "wallet.remit":
      return t(locale, "butler.speaker.kindWalletRemit");
    case "wallet.remitFailed":
      return t(locale, "butler.speaker.kindWalletRemitFailed");
  }
}

function systemPrompt(
  event: SpeakEvent,
  locale: Locale,
  channelName: string | null,
  leadMode: boolean,
): string {
  const instruction = t(locale, "butler.speaker.instruction");
  const lines = leadMode
    ? [
        t(locale, "butler.speaker.leadInstruction"),
        ...instruction.split("\n").slice(1),
      ]
    : [
        instruction,
        event.kind === "task.failed" && event.retryable
          ? t(locale, "butler.speaker.retryInstruction")
          : "",
      ];
  return [
    persona(locale, channelName),
    "",
    lines.filter((line) => line !== "").join("\n"),
    "",
    phoneRules(locale, { conversational: false }),
  ].join("\n");
}

function userMessage(
  event: SpeakEvent,
  locale: Locale,
  recent: string[],
): string {
  const lines = [
    t(locale, "butler.speaker.userHeader"),
    t(locale, "butler.speaker.userKind", { kind: kindLabel(event, locale) }),
    event.kind === "bot.message"
      ? t(locale, "butler.speaker.userBot", { botName: event.botName })
      : event.kind === "life.tier" ||
          event.kind === "wallet.remit" ||
          event.kind === "wallet.remitFailed"
        ? ""
        : t(locale, "butler.speaker.userTitle", { title: event.title }),
    "",
    event.body,
  ];
  if (recent.length > 0) {
    lines.push(
      "",
      t(locale, "butler.speaker.recentTitle"),
      ...recent.map((line) => `- ${line}`),
    );
  }
  return lines.join("\n");
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/** Rejects as soon as `signal` aborts, even if the model ignores it. */
export function abortRace(signal: AbortSignal): {
  promise: Promise<never>;
  cleanup: () => void;
} {
  let cleanup = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => signal.removeEventListener("abort", onAbort);
  });
  return { promise, cleanup };
}

/**
 * Rewrites an event in the butler's voice, falling back to the original text.
 *
 * The model may only change tone and structure; a rewrite that drops a number
 * or a link, comes back blank, fails, or takes too long is discarded.
 */
export async function speak(
  event: SpeakEvent,
  deps: {
    complete: SpeakComplete;
    locale: Locale;
    channelName: string | null;
    recent: string[];
    timeoutMs?: number;
  },
): Promise<string> {
  const fallback = fallbackText(event, deps.locale);
  if (!bodyPresent(event.body)) return fallback;

  const signal = AbortSignal.timeout(deps.timeoutMs ?? SPEAK_TIMEOUT_MS);
  const aborted = abortRace(signal);
  const leadMode = [...event.body].length > rewriteLimit(deps.locale);

  try {
    const text = (
      await Promise.race([
        deps.complete(
          systemPrompt(event, deps.locale, deps.channelName, leadMode),
          userMessage(event, deps.locale, deps.recent),
          signal,
        ),
        aborted.promise,
      ])
    ).trim();

    if (leadMode) {
      if (text !== "" && [...text].length <= LEAD_MAX) {
        return `${text}\n\n${fallback}`;
      }
      return fallback;
    }
    if (text === "" || missingFacts(event.body, text).length > 0) {
      return fallback;
    }
    return text;
  } catch {
    return fallback;
  } finally {
    aborted.cleanup();
  }
}
