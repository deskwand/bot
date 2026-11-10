import { t, type Locale } from "../i18n";
import type { Artifact } from "../protocol";

/** Characters a message may take on a phone screen. */
export const PHONE_BUDGET: Record<Locale, number> = { zh: 300, en: 600 };
export const CODE_BLOCK_MAX_LINES = 10;
export const COMPRESS_TIMEOUT_MS = 15_000;

export type PhoneViolation = "length" | "format";

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}/;

function hasTable(lines: string[]): boolean {
  for (let index = 0; index + 1 < lines.length; index++) {
    if (lines[index]!.includes("|") && TABLE_SEPARATOR.test(lines[index + 1]!)) {
      return true;
    }
  }
  return false;
}

function hasSeveralHeadings(lines: string[]): boolean {
  let count = 0;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) count++;
    if (count >= 2) return true;
  }
  return false;
}

function hasLongCodeBlock(lines: string[]): boolean {
  let fence: { char: string; length: number } | null = null;
  let contentLines = 0;

  for (const line of lines) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (match) {
        fence = { char: match[1]![0]!, length: match[1]!.length };
        contentLines = 0;
      }
      continue;
    }
    if (
      match &&
      match[1]![0] === fence.char &&
      match[1]!.length >= fence.length
    ) {
      if (contentLines > CODE_BLOCK_MAX_LINES) return true;
      fence = null;
      continue;
    }
    contentLines++;
  }

  return fence !== null && contentLines > CODE_BLOCK_MAX_LINES;
}

function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Returns why a message is unfit for a phone screen, or `null` when it fits.
 * Length is checked first: a user who sent a wall of text needs the original
 * saved even if its formatting is fine.
 */
export function phoneViolation(
  text: string,
  locale: Locale,
): PhoneViolation | null {
  if (codePointLength(text) > PHONE_BUDGET[locale]) return "length";

  const lines = text.split("\n");
  if (
    hasTable(lines) ||
    hasSeveralHeadings(lines) ||
    hasLongCodeBlock(lines)
  ) {
    return "format";
  }
  return null;
}

export type PhoneFitDeps = {
  complete(system: string, user: string, signal: AbortSignal): Promise<string>;
  saveOriginal(text: string): Promise<Artifact>;
};

export type PhoneFit = { text: string; attachments: Artifact[] };

async function completeWithinTimeout(
  deps: PhoneFitDeps,
  system: string,
  user: string,
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("phone compression timed out"));
    }, COMPRESS_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      deps.complete(system, user, controller.signal),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Truncates whole paragraphs, splitting a paragraph only when it alone overflows. */
function truncateToLimit(text: string, limit: number): string {
  let kept = "";
  for (const paragraph of text.split("\n\n")) {
    const candidate = kept === "" ? paragraph : `${kept}\n\n${paragraph}`;
    if (codePointLength(candidate) <= limit) {
      kept = candidate;
      continue;
    }
    if (kept === "") {
      kept = [...paragraph].slice(0, limit).join("");
    }
    break;
  }
  return kept;
}

async function saveOriginalOrNothing(
  deps: PhoneFitDeps,
  text: string,
): Promise<Artifact | null> {
  try {
    return await deps.saveOriginal(text);
  } catch (error) {
    console.warn(
      `phone original not saved: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Makes one model-written message fit a phone. Compliant text passes through;
 * otherwise the text is compressed once, and truncation with the original
 * attached is the fallback so a message is never lost.
 */
export async function fitForPhone(
  text: string,
  locale: Locale,
  deps: PhoneFitDeps,
): Promise<PhoneFit> {
  const violation = phoneViolation(text, locale);
  if (violation === null) return { text, attachments: [] };

  let compressed: string | null = null;
  try {
    const result = await completeWithinTimeout(
      deps,
      t(locale, "phone.compressSystem"),
      text,
    );
    if (result.trim() !== "" && codePointLength(result) <= PHONE_BUDGET[locale]) {
      compressed = result;
    }
  } catch (error) {
    console.warn(
      `phone compression skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (compressed !== null) {
    const original =
      violation === "length"
        ? await saveOriginalOrNothing(deps, text)
        : null;
    return {
      text: compressed,
      attachments: original === null ? [] : [original],
    };
  }

  // A format-only message was never too long, so leave it untouched rather
  // than promising a full-text file for text that was never cut.
  if (violation === "format") return { text, attachments: [] };

  const original = await saveOriginalOrNothing(deps, text);
  // Without a file the owner would only get the cut-down text and lose the
  // rest, so send the whole message instead.
  if (original === null) return { text, attachments: [] };

  const suffix = t(locale, "phone.truncatedSuffix");
  const truncated = truncateToLimit(
    text,
    PHONE_BUDGET[locale] - codePointLength(suffix),
  );
  return { text: `${truncated}${suffix}`, attachments: [original] };
}
