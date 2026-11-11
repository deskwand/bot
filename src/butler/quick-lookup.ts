import { t, type Locale } from "../i18n";
import { abortRace, type SpeakComplete } from "./speaker";

/** The whole lookup, searches included, must answer within this window. */
export const LOOKUP_TIMEOUT_MS = 30_000;

/** More searches than this stop being quick. */
export const LOOKUP_MAX_QUERIES = 3;

/** The model's reply when the results cannot answer the question. */
export const NO_ANSWER = "NO_ANSWER";

/** Longest answer the owner gets; longer replies are cut. */
export function answerLimit(locale: Locale): number {
  return locale === "en" ? 600 : 300;
}

function searchTerms(question: string, queries: string[]): string[] {
  const terms = queries
    .map((query) => query.trim())
    .filter((query) => query !== "")
    .slice(0, LOOKUP_MAX_QUERIES);
  return terms.length > 0 ? terms : [question];
}

/**
 * Answers a small factual question from a bounded number of web searches.
 *
 * Returns `{ ok: false }` whenever it cannot produce an answer: no search
 * succeeded, the model found nothing (`NO_ANSWER` or blank), or the whole
 * lookup exceeded its timeout.
 */
export async function quickLookup(
  input: { question: string; queries: string[] },
  deps: {
    search: (query: string, signal: AbortSignal) => Promise<{ ok: boolean; text: string }>;
    complete: SpeakComplete;
    locale: Locale;
    timeoutMs?: number;
  },
): Promise<{ ok: true; answer: string } | { ok: false }> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? LOOKUP_TIMEOUT_MS);
  const aborted = abortRace(signal);

  try {
    const results = await Promise.race([
      Promise.all(
        searchTerms(input.question, input.queries).map((query) =>
          deps.search(query, signal),
        ),
      ),
      aborted.promise,
    ]);

    const hits = results.filter((result) => result.ok);
    if (hits.length === 0) return { ok: false };

    const user = [
      t(deps.locale, "butler.quickLookup.question", {
        question: input.question,
      }),
      "",
      t(deps.locale, "butler.quickLookup.results"),
      ...hits.map((result) => result.text),
    ].join("\n");

    const answer = (
      await Promise.race([
        deps.complete(
          t(deps.locale, "butler.quickLookup.system", {
            limit: answerLimit(deps.locale),
          }),
          user,
          signal,
        ),
        aborted.promise,
      ])
    ).trim();

    if (answer === "" || answer === NO_ANSWER) return { ok: false };
    return {
      ok: true,
      answer: [...answer].slice(0, answerLimit(deps.locale)).join(""),
    };
  } catch {
    return { ok: false };
  } finally {
    aborted.cleanup();
  }
}
