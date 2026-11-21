import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { CODEX_PROVIDER_ID } from "../llm/codex";
import type { ModelRef } from "../llm/models";
import { readRuntimeConfig } from "../runtime-config";
import { braveAdapter } from "./search/brave";
import { subscriptionSearch } from "./search/codex";
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
 * Search the web for a task. A task on the Codex subscription searches through
 * the subscription's own tool first — it costs nothing extra and cites the
 * pages it read — and falls back to the configured provider when that path is
 * unavailable. The note names only the reason: whether the fallback ended up on
 * the configured provider or on Exa is `searchWeb`'s own story to tell.
 */
export async function searchWebWithModel(
  env: Env,
  model: ModelRef | undefined,
  query: string,
  maxResults: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; text: string }> {
  if (model?.provider !== CODEX_PROVIDER_ID) {
    return await searchWeb(env, query, maxResults, signal, fetchImpl);
  }

  try {
    const results = await subscriptionSearch(env, model, query, signal, fetchImpl);
    // An empty answer is how a blocked account shows up: treat it as a failure.
    if (results.length === 0) throw new Error("没有返回内容"); // i18n-ignore: model-facing
    return { ok: true, text: truncate(formatResults(results)) };
  } catch (error) {
    if (signal.aborted) return { ok: false, text: timeoutText() };
    console.warn(
      `web_search: subscription search failed, using the configured provider: ${errorMessage(error)}`,
    );
    const fallback = await searchWeb(env, query, maxResults, signal, fetchImpl);
    const note = `（订阅搜索不可用：${errorMessage(error)}）\n`; // i18n-ignore: model-facing
    return { ok: fallback.ok, text: note + fallback.text };
  }
}

/**
 * Search the web for the model. Read-only, so safe to replay after a restart.
 */
export function webSearchTool(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  /** The model this task runs on; read per call, after the session picked it. */
  currentModel: () => ModelRef | undefined = () => undefined,
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

      const result = await searchWebWithModel(
        env,
        currentModel(),
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
