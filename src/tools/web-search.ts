import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

const Search = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
});

const TAVILY_URL = "https://api.tavily.com/search";
const SEARCH_TIMEOUT_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textResult(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

type TavilyResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
};

type TavilyResponse = {
  results?: TavilyResult[];
};

/** Search the web through Tavily. Read-only, so safe to replay after a restart. */
export function webSearchTool(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): ToolRegistration<typeof Search> {
  return {
    name: "web_search",
    description: "Search the web for current information.",
    parameters: Search,
    replay: "safe",
    async execute({ query, maxResults }, _api, context) {
      const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
      const signal = context.abortSignal
        ? AbortSignal.any([context.abortSignal, timeout])
        : timeout;

      let response: Response;
      try {
        response = await fetchImpl(TAVILY_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            query,
            max_results: maxResults ?? 5,
            search_depth: "basic",
          }),
          signal,
        });
      } catch (error) {
        // Caller cancellation must propagate so the run stops; only the
        // tool's own timeout becomes a normal answer.
        if (context.abortSignal?.aborted) throw error;
        if (timeout.aborted) {
          return textResult(
            `搜索超时：超过 ${SEARCH_TIMEOUT_MS / 1000} 秒`,
          );
        }
        return textResult(`搜索失败：${errorMessage(error)}`);
      }

      if (!response.ok) {
        throw new Error(`搜索服务返回 HTTP ${response.status}`);
      }

      const data = (await response.json()) as TavilyResponse;
      const results = Array.isArray(data.results) ? data.results : [];
      const text =
        results.length === 0
          ? "没有找到搜索结果。"
          : results
              .map((result) =>
                [
                  String(result.title ?? ""),
                  String(result.url ?? ""),
                  String(result.content ?? ""),
                ].join("\n"),
              )
              .join("\n\n");

      return { output: [{ type: "text", text }] };
    },
  };
}
