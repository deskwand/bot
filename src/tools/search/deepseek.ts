/**
 * DeepSeek search adapter.
 *
 * 接口核实日期：2026-11-10
 * https://api-docs.deepseek.com/guides/search
 * https://api-docs.deepseek.com/api/search
 */
import { clampCount, fetchJson } from "./http";
import type { SearchAdapter } from "./types";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/tools/search";
const MAX_RESULTS_CAP = 50;

type DeepseekResult = {
  title?: unknown;
  url?: unknown;
  summary?: unknown;
  snippet?: unknown;
};

function isResult(item: unknown): item is DeepseekResult & { url: string } {
  if (typeof item !== "object" || item === null) return false;
  const { url } = item as DeepseekResult;
  return typeof url === "string" && url !== "";
}

function resultSnippet(item: DeepseekResult): string {
  if (typeof item.summary === "string" && item.summary !== "") {
    return item.summary;
  }
  return typeof item.snippet === "string" ? item.snippet : "";
}

export function deepseekAdapter(
  key: string,
  fetchImpl: typeof fetch,
): SearchAdapter {
  return {
    id: "deepseek",
    label: "DeepSeek",
    async search(query, max, signal) {
      const body = await fetchJson(fetchImpl, DEEPSEEK_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          count: clampCount(max, MAX_RESULTS_CAP),
        }),
        signal,
      });

      const results = (body as { results?: unknown } | null)?.results;
      if (!Array.isArray(results)) throw new Error("响应格式不对");

      return results.filter(isResult).map((item) => ({
        title: typeof item.title === "string" ? item.title : "",
        url: item.url,
        snippet: resultSnippet(item),
      }));
    },
  };
}
