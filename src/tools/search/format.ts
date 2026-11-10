import type { SearchResult } from "./types";

export const MAX_TEXT_CHARS = 20_000;
const TRUNCATION_MARKER = "\n\n[已截断]";

export function formatResults(results: SearchResult[]): string {
  return results
    .map((result) =>
      [result.title, result.url, result.snippet]
        .filter((part) => part !== "")
        .join("\n"),
    )
    .join("\n\n");
}

export function truncate(text: string): string {
  return text.length <= MAX_TEXT_CHARS
    ? text
    : text.slice(0, MAX_TEXT_CHARS) + TRUNCATION_MARKER;
}
