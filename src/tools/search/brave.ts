import { clampCount, fetchJson } from "./http";
import type { SearchAdapter } from "./types";

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const MAX_RESULTS_CAP = 20;

type BraveResult = {
  title?: unknown;
  url?: unknown;
  description?: unknown;
};

function isResult(item: unknown): item is BraveResult & { url: string } {
  if (typeof item !== "object" || item === null) return false;
  const { url } = item as BraveResult;
  return typeof url === "string" && url !== "";
}

export function braveAdapter(
  key: string,
  fetchImpl: typeof fetch,
): SearchAdapter {
  return {
    id: "brave",
    label: "Brave",
    async search(query, max, signal) {
      const url = new URL(BRAVE_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(clampCount(max, MAX_RESULTS_CAP)));

      const body = await fetchJson(fetchImpl, url.toString(), {
        method: "GET",
        headers: {
          "X-Subscription-Token": key,
          Accept: "application/json",
        },
        signal,
      });

      const web = (body as { web?: unknown } | null)?.web;
      if (web === undefined) return [];
      const results = (web as { results?: unknown } | null)?.results;
      if (results === undefined) return [];
      if (!Array.isArray(results)) throw new Error("响应格式不对");

      return results.filter(isResult).map((item) => ({
        title: typeof item.title === "string" ? item.title : "",
        url: item.url,
        snippet: typeof item.description === "string" ? item.description : "",
      }));
    },
  };
}
