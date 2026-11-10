import { clampCount, fetchJson } from "./http";
import type { SearchAdapter } from "./types";

const TAVILY_URL = "https://api.tavily.com/search";
const MAX_RESULTS_CAP = 20;

type TavilyResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
};

function isResult(item: unknown): item is TavilyResult & { url: string } {
  if (typeof item !== "object" || item === null) return false;
  const { url } = item as TavilyResult;
  return typeof url === "string" && url !== "";
}

export function tavilyAdapter(
  key: string,
  fetchImpl: typeof fetch,
): SearchAdapter {
  return {
    id: "tavily",
    label: "Tavily",
    async search(query, max, signal) {
      const body = await fetchJson(fetchImpl, TAVILY_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          max_results: clampCount(max, MAX_RESULTS_CAP),
          search_depth: "basic",
        }),
        signal,
      });

      const results = (body as { results?: unknown } | null)?.results;
      if (!Array.isArray(results)) throw new Error("响应格式不对");

      return results.filter(isResult).map((item) => ({
        title: typeof item.title === "string" ? item.title : "",
        url: item.url,
        snippet: typeof item.content === "string" ? item.content : "",
      }));
    },
  };
}
