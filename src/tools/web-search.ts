import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { readRuntimeConfig } from "../runtime-config";
import { braveAdapter } from "./search/brave";
import { deepseekAdapter } from "./search/deepseek";
import { exaAdapter } from "./search/exa";
import { formatResults, truncate } from "./search/format";
import { tavilyAdapter } from "./search/tavily";
import {
  SEARCH_PROVIDER_IDS,
  type SearchAdapter,
  type SearchProviderId,
} from "./search/types";

const Search = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
});

const DEFAULT_MAX_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 30_000;

const SEARCH_KEY_NAMES: Record<SearchProviderId, string | null> = {
  exa: null,
  tavily: "SEARCH_KEY_TAVILY",
  brave: "SEARCH_KEY_BRAVE",
  deepseek: "MODEL_KEY_DEEPSEEK",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textResult(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

function timeoutText(): string {
  return `搜索超时：超过 ${SEARCH_TIMEOUT_MS / 1000} 秒`;
}

/** The configured provider; an unreadable or unknown value means `exa`. */
export function searchProvider(env: Env): SearchProviderId {
  try {
    const provider = readRuntimeConfig(env).search?.provider;
    return provider !== undefined && SEARCH_PROVIDER_IDS.includes(provider)
      ? provider
      : "exa";
  } catch {
    return "exa";
  }
}

/** The provider's key, trimmed; blank or missing means undefined. */
export function searchKey(
  env: Env,
  id: SearchProviderId,
): string | undefined {
  const name = SEARCH_KEY_NAMES[id];
  if (name === null) return undefined;
  const value = (env as unknown as Record<string, unknown>)[name];
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return key === "" ? undefined : key;
}

function createAdapter(
  id: SearchProviderId,
  key: string | undefined,
  fetchImpl: typeof fetch,
): SearchAdapter {
  switch (id) {
    case "tavily":
      return tavilyAdapter(key ?? "", fetchImpl);
    case "brave":
      return braveAdapter(key ?? "", fetchImpl);
    case "deepseek":
      return deepseekAdapter(key ?? "", fetchImpl);
    default:
      return exaAdapter(fetchImpl);
  }
}

/**
 * Search the web through the configured provider, falling back once to Exa if
 * that provider fails. `ok` is false for a failure, a timeout, an abort, or no
 * results.
 */
export async function searchWeb(
  env: Env,
  query: string,
  maxResults: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; text: string }> {
  let id = searchProvider(env);
  const key = searchKey(env, id);
  if (id !== "exa" && key === undefined) {
    console.warn(`web_search: ${id} key missing, using exa`);
    id = "exa";
  }
  const selected = createAdapter(
    id,
    id === "exa" ? undefined : key,
    fetchImpl,
  );

  try {
    const results = await selected.search(query, maxResults, signal);
    return results.length > 0
      ? { ok: true, text: truncate(formatResults(results)) }
      : { ok: false, text: "没有找到搜索结果。" };
  } catch (error) {
    if (signal.aborted) return { ok: false, text: timeoutText() };
    if (id === "exa") {
      return { ok: false, text: `搜索失败：${errorMessage(error)}` };
    }

    const note = `（${selected.label} 不可用：${errorMessage(error)}，已改用 Exa）\n`;
    try {
      const results = await exaAdapter(fetchImpl).search(
        query,
        maxResults,
        signal,
      );
      return results.length > 0
        ? { ok: true, text: note + truncate(formatResults(results)) }
        : { ok: false, text: note + "没有找到搜索结果。" };
    } catch (fallbackError) {
      if (signal.aborted) return { ok: false, text: timeoutText() };
      return { ok: false, text: `搜索失败：${errorMessage(fallbackError)}` };
    }
  }
}

/**
 * Search the web for the model. Read-only, so safe to replay after a restart.
 */
export function webSearchTool(
  env: Env,
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

      const result = await searchWeb(
        env,
        query,
        maxResults ?? DEFAULT_MAX_RESULTS,
        signal,
        fetchImpl,
      );
      // Caller cancellation must propagate so the run stops; only the tool's
      // own timeout becomes a normal answer.
      if (context.abortSignal?.aborted) throw context.abortSignal.reason;
      return textResult(result.text);
    },
  };
}
