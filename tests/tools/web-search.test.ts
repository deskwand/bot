import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionResult, ToolPark } from "@earendil-works/pi-durable";
import { toolResult } from "../helpers/tool-result";
import { describe, expect, it, vi } from "vitest";
import { searchWeb, searchWebWithModel, webSearchTool } from "../../src/tools/web-search";
import { fakeCodexToken } from "../helpers/codex-token";

type RecordedCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
  body: Record<string, unknown>;
};

const BASE_CONFIG = {
  schemaVersion: 1,
  owner: { telegramUserIds: [] },
  models: {
    butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  },
  mcpServers: [],
};

function envWith(
  search?: { provider: string },
  secrets: Record<string, string> = {},
): Env {
  return {
    DESKWAND_CONFIG: search ? { ...BASE_CONFIG, search } : BASE_CONFIG,
    ...secrets,
  } as unknown as Env;
}

function context(signal?: AbortSignal): Context {
  return { abortSignal: signal } as unknown as Context;
}

function textOf(parked: ToolExecutionResult | ToolPark): string {
  const result = toolResult(parked);
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sseResponse(
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

/**
 * Fake Exa MCP server: answers initialize with a session header, accepts the
 * initialized notification, and delegates tools/call to `onCall`.
 */
function exaFetch(
  onCall: (body: Record<string, unknown>) => Response,
  calls: RecordedCall[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ input, init, body });

    if (body.method === "initialize") {
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "exa", version: "test" },
          },
        },
        { "mcp-session-id": "sess-1" },
      );
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, {
        status: 202,
        headers: { "mcp-session-id": "sess-1" },
      });
    }
    if (body.method === "tools/call") return onCall(body);
    throw new Error(`unexpected MCP method: ${String(body.method)}`);
  }) as typeof fetch;
}

function toolCall(calls: RecordedCall[]): RecordedCall {
  const call = calls.find((item) => item.body.method === "tools/call");
  if (!call) throw new Error("tools/call was not sent");
  return call;
}

type Routes = {
  tavily?: () => Response;
  brave?: () => Response;
  deepseek?: () => Response;
  exa?: (body: Record<string, unknown>) => Response;
  codex?: () => Response;
};

/**
 * Route requests by host. Exa keeps the full MCP session handshake; any other
 * host must have a route, which makes an unexpected request a loud failure.
 */
function providerFetch(
  routes: Routes,
  calls: RecordedCall[] = [],
): typeof fetch {
  const exa = exaFetch(
    routes.exa ??
      (() =>
        jsonResponse({
          jsonrpc: "2.0",
          result: { content: [{ type: "text", text: "Exa result" }] },
        })),
    calls,
  );

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(String(input)).host;
    if (host === "mcp.exa.ai") return exa(input, init);

    calls.push({
      input,
      init,
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    if (host === "api.tavily.com" && routes.tavily) return routes.tavily();
    if (host === "api.search.brave.com" && routes.brave) return routes.brave();
    if (host === "chatgpt.com" && routes.codex) return routes.codex();
    if (host === "api.deepseek.com" && routes.deepseek) {
      return routes.deepseek();
    }
    throw new Error(`unexpected host: ${host}`);
  }) as typeof fetch;
}

function hosts(calls: RecordedCall[]): string[] {
  return calls.map((call) => new URL(String(call.input)).host);
}

describe("webSearchTool", () => {
  it("initializes an Exa MCP session and calls web_search_exa", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = exaFetch(
      () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [
              {
                type: "text",
                text: "Title: Cloudflare Workers\nURL: https://workers.cloudflare.com/\nRun code at the edge.",
              },
            ],
          },
        }),
      calls,
    );

    const controller = new AbortController();
    const tool = webSearchTool(envWith(), fakeFetch);
    const result = await tool.execute(
      { query: "cloudflare workers" },
      {} as never,
      context(controller.signal),
    );

    const initialize = calls.find((item) => item.body.method === "initialize");
    expect(initialize?.body).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
    });
    expect(
      calls.some((item) => item.body.method === "notifications/initialized"),
    ).toBe(true);

    const call = toolCall(calls);
    expect(String(call.input)).toBe("https://mcp.exa.ai/mcp");
    expect(call.init?.method).toBe("POST");
    expect(call.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query: "cloudflare workers", numResults: 5 },
      },
    });
    const headers = new Headers(call.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(headers.get("mcp-session-id")).toBe("sess-1");

    const signal = call.init?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);

    const text = textOf(result);
    expect(text).toContain("Cloudflare Workers");
    expect(text).toContain("https://workers.cloudflare.com/");
    expect(tool.replay).toBe("safe");
  });

  it("parses an SSE JSON-RPC response", async () => {
    const fakeFetch = exaFetch(() =>
      sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: "SSE search result" }],
        },
      }),
    );

    const result = await webSearchTool(envWith(), fakeFetch).execute(
      { query: "q" },
      {} as never,
      context(),
    );

    expect(textOf(result)).toBe("SSE search result");
  });

  it("reports a JSON-RPC error as a search failure", async () => {
    const fakeFetch = exaFetch(() =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32603, message: "backend exploded" },
      }),
    );

    const result = await webSearchTool(envWith(), fakeFetch).execute(
      { query: "q" },
      {} as never,
      context(),
    );

    expect(textOf(result)).toContain("搜索失败：backend exploded");
  });

  it("reports an isError tool result as a search failure", async () => {
    const fakeFetch = exaFetch(() =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          isError: true,
          content: [{ type: "text", text: "rate limit exceeded" }],
        },
      }),
    );

    const result = await webSearchTool(envWith(), fakeFetch).execute(
      { query: "q" },
      {} as never,
      context(),
    );

    expect(textOf(result)).toContain("搜索失败：rate limit exceeded");
  });

  it("reports its own timeout as a friendly message", async () => {
    const timeout = AbortSignal.abort(
      new DOMException("timed out", "TimeoutError"),
    );
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout);

    try {
      const fakeFetch = (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        throw init!.signal!.reason;
      }) as typeof fetch;

      const result = await webSearchTool(envWith(), fakeFetch).execute(
        { query: "q" },
        {} as never,
        context(),
      );

      expect(textOf(result)).toContain("搜索超时");
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("rethrows a caller abort", async () => {
    const controller = new AbortController();
    const fakeFetch = ((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      })) as typeof fetch;

    const tool = webSearchTool(envWith(), fakeFetch);
    setTimeout(() => controller.abort(), 10);

    await expect(
      tool.execute({ query: "q" }, {} as never, context(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("honours maxResults", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = exaFetch(
      () =>
        jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "result" }] },
        }),
      calls,
    );

    await webSearchTool(envWith(), fakeFetch).execute(
      { query: "q", maxResults: 3 },
      {} as never,
      context(),
    );

    expect(toolCall(calls).body).toMatchObject({
      params: { arguments: { numResults: 3 } },
    });
  });

  it("truncates very long Exa output", async () => {
    const fakeFetch = exaFetch(() =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: "x".repeat(20_100) }] },
      }),
    );

    const text = textOf(
      await webSearchTool(envWith(), fakeFetch).execute(
        { query: "q" },
        {} as never,
        context(),
      ),
    );

    expect(text).toHaveLength(20_000 + "\n\n[已截断]".length);
    expect(text.endsWith("[已截断]")).toBe(true);
  });
});

describe("webSearchTool provider selection", () => {
  it("uses the selected provider", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = providerFetch(
      {
        tavily: () =>
          jsonResponse({
            results: [
              { title: "T", url: "https://t", content: "tavily snippet" },
            ],
          }),
      },
      calls,
    );

    const text = textOf(
      await webSearchTool(
        envWith({ provider: "tavily" }, { SEARCH_KEY_TAVILY: "tvly-key" }),
        fakeFetch,
      ).execute({ query: "q" }, {} as never, context()),
    );

    expect(text).toContain("tavily snippet");
    expect(text).not.toContain("已改用");
    expect(hosts(calls)).toEqual(["api.tavily.com"]);
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
      "Bearer tvly-key",
    );
  });

  it("uses exa when the selected provider has no key", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = providerFetch({}, calls);

    const text = textOf(
      await webSearchTool(
        envWith({ provider: "brave" }),
        fakeFetch,
      ).execute({ query: "q" }, {} as never, context()),
    );

    expect(text).toContain("Exa result");
    expect(text).not.toContain("已改用");
    expect(hosts(calls).every((host) => host === "mcp.exa.ai")).toBe(true);
  });

  it("uses exa when the selected provider key is blank", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = providerFetch({}, calls);

    const text = textOf(
      await webSearchTool(
        envWith(
          { provider: "tavily" },
          { SEARCH_KEY_TAVILY: "  \n" },
        ),
        fakeFetch,
      ).execute({ query: "q" }, {} as never, context()),
    );

    expect(text).toContain("Exa result");
    expect(text).not.toContain("已改用");
    expect(hosts(calls).every((host) => host === "mcp.exa.ai")).toBe(true);
  });

  it("uses exa when the configuration cannot be read", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = providerFetch({}, calls);

    const text = textOf(
      await webSearchTool(
        { DESKWAND_CONFIG: "{" } as unknown as Env,
        fakeFetch,
      ).execute({ query: "q" }, {} as never, context()),
    );

    expect(text).toContain("Exa result");
    expect(hosts(calls).every((host) => host === "mcp.exa.ai")).toBe(true);
  });

  it("falls back to exa with a note when the selected provider fails", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = providerFetch(
      {
        tavily: () => new Response("nope", { status: 429 }),
        exa: () =>
          jsonResponse({
            jsonrpc: "2.0",
            result: { content: [{ type: "text", text: "exa after fallback" }] },
          }),
      },
      calls,
    );

    const text = textOf(
      await webSearchTool(
        envWith({ provider: "tavily" }, { SEARCH_KEY_TAVILY: "tvly-key" }),
        fakeFetch,
      ).execute({ query: "q" }, {} as never, context()),
    );

    expect(text).toMatch(/^（Tavily 不可用：HTTP 429，已改用 Exa）\n/);
    expect(text).toContain("exa after fallback");
  });

  it("does not fall back when the selected provider returns no results", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = providerFetch(
      { tavily: () => jsonResponse({ results: [] }) },
      calls,
    );

    const text = textOf(
      await webSearchTool(
        envWith({ provider: "tavily" }, { SEARCH_KEY_TAVILY: "tvly-key" }),
        fakeFetch,
      ).execute({ query: "q" }, {} as never, context()),
    );

    expect(text).toBe("没有找到搜索结果。");
    expect(hosts(calls)).toEqual(["api.tavily.com"]);
  });

  it("reports a failure when both providers fail", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = providerFetch(
      {
        tavily: () => new Response("nope", { status: 500 }),
        exa: () => new Response("nope", { status: 500 }),
      },
      calls,
    );

    const text = textOf(
      await webSearchTool(
        envWith({ provider: "tavily" }, { SEARCH_KEY_TAVILY: "tvly-key" }),
        fakeFetch,
      ).execute({ query: "q" }, {} as never, context()),
    );

    expect(text.startsWith("搜索失败：")).toBe(true);
    expect(hosts(calls)).toContain("mcp.exa.ai");
  });

  it("rethrows a caller abort without falling back", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ input, init, body: {} });
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;

    const controller = new AbortController();
    controller.abort();

    await expect(
      webSearchTool(
        envWith({ provider: "tavily" }, { SEARCH_KEY_TAVILY: "tvly-key" }),
        fakeFetch,
      ).execute({ query: "q" }, {} as never, context(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(hosts(calls)).not.toContain("mcp.exa.ai");
  });

  it("reports a selected-provider timeout without falling back", async () => {
    const timeout = AbortSignal.abort(
      new DOMException("timed out", "TimeoutError"),
    );
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout);

    try {
      const calls: RecordedCall[] = [];
      const fakeFetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        calls.push({ input, init, body: {} });
        throw init!.signal!.reason;
      }) as typeof fetch;

      const text = textOf(
        await webSearchTool(
          envWith({ provider: "tavily" }, { SEARCH_KEY_TAVILY: "tvly-key" }),
          fakeFetch,
        ).execute({ query: "q" }, {} as never, context()),
      );

      expect(text).toContain("搜索超时");
      expect(hosts(calls)).not.toContain("mcp.exa.ai");
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("reuses the model key for deepseek", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = providerFetch(
      {
        deepseek: () =>
          jsonResponse({
            results: [
              { title: "D", url: "https://d", summary: "deepseek snippet" },
            ],
          }),
      },
      calls,
    );

    const text = textOf(
      await webSearchTool(
        envWith({ provider: "deepseek" }, { MODEL_KEY_DEEPSEEK: "ds-key" }),
        fakeFetch,
      ).execute({ query: "q" }, {} as never, context()),
    );

    expect(text).toContain("deepseek snippet");
    expect(hosts(calls)).toEqual(["api.deepseek.com"]);
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
      "Bearer ds-key",
    );
  });
});

describe("searchWeb", () => {
  it("returns ok with the formatted results", async () => {
    const fakeFetch = exaFetch(() =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: "Title: Cloudflare Workers" }],
        },
      }),
    );

    const result = await searchWeb(
      envWith(),
      "q",
      5,
      new AbortController().signal,
      fakeFetch,
    );

    expect(result.ok).toBe(true);
    expect(result.text).toContain("Cloudflare Workers");
  });

  it("returns not ok when there are no results", async () => {
    const fakeFetch = providerFetch({
      tavily: () => jsonResponse({ results: [] }),
    });

    const result = await searchWeb(
      envWith({ provider: "tavily" }, { SEARCH_KEY_TAVILY: "tvly-key" }),
      "q",
      5,
      new AbortController().signal,
      fakeFetch,
    );

    expect(result).toEqual({ ok: false, text: "没有找到搜索结果。" });
  });

  it("returns not ok when both providers fail", async () => {
    const fakeFetch = providerFetch({
      tavily: () => new Response("nope", { status: 500 }),
      exa: () => new Response("nope", { status: 500 }),
    });

    const result = await searchWeb(
      envWith({ provider: "tavily" }, { SEARCH_KEY_TAVILY: "tvly-key" }),
      "q",
      5,
      new AbortController().signal,
      fakeFetch,
    );

    expect(result.ok).toBe(false);
    expect(result.text.startsWith("搜索失败：")).toBe(true);
  });
});

const CODEX_MODEL = { provider: "openai-codex", id: "gpt-6.2-sol" };

/** An Env whose life object hands back the given credential, or nothing. */
function subscriptionEnv(credential?: unknown): Env {
  return {
    DESKWAND_CONFIG: BASE_CONFIG,
    LIFE: {
      idFromName: () => "global",
      get: () => ({ modelCredential: async () => credential }),
    },
  } as unknown as Env;
}

const LIVE_CREDENTIAL = {
  type: "oauth",
  access: fakeCodexToken(),
  refresh: "refresh-0",
  expires: Date.now() + 3_600_000,
};

function codexStream(
  text: string,
  citations: Array<{ title: string; url: string }> = [],
): Response {
  const events = [
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        content: [
          {
            type: "output_text",
            text,
            annotations: citations.map((citation) => ({
              type: "url_citation",
              ...citation,
            })),
          },
        ],
      },
    },
    { type: "response.completed" },
  ];
  return new Response(
    events
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("subscription search", () => {
  it("searches through the subscription for a codex model", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = providerFetch(
      { codex: () => codexStream("1 BTC 约 58,132 美元。") },
      calls,
    );

    const result = await searchWebWithModel(
      subscriptionEnv(LIVE_CREDENTIAL),
      CODEX_MODEL,
      "bitcoin price",
      5,
      AbortSignal.timeout(5_000),
      fakeFetch,
    );

    expect(result.ok).toBe(true);
    expect(result.text).toContain("58,132");
    expect(hosts(calls)).toEqual(["chatgpt.com"]);
  });

  it("falls back to the configured provider when the subscription fails", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = providerFetch(
      {
        codex: () =>
          new Response("<html>blocked</html>", {
            status: 403,
            headers: { "content-type": "text/html" },
          }),
      },
      calls,
    );

    const result = await searchWebWithModel(
      subscriptionEnv(LIVE_CREDENTIAL),
      CODEX_MODEL,
      "bitcoin price",
      5,
      AbortSignal.timeout(5_000),
      fakeFetch,
    );

    expect(result.ok).toBe(true);
    expect(result.text).toContain("（订阅搜索不可用：Codex 搜索返回 HTTP 403）");
    expect(result.text).toContain("Exa result");
    expect(new Set(hosts(calls))).toEqual(new Set(["chatgpt.com", "mcp.exa.ai"]));
  });

  it("falls back when there is no subscription to use", async () => {
    const result = await searchWebWithModel(
      subscriptionEnv(undefined),
      CODEX_MODEL,
      "q",
      5,
      AbortSignal.timeout(5_000),
      providerFetch({}),
    );

    expect(result.text).toContain("（订阅搜索不可用：没有可用的 Codex 授权）");
    expect(result.text).toContain("Exa result");
  });

  it("falls back when the subscription answers nothing", async () => {
    const result = await searchWebWithModel(
      subscriptionEnv(LIVE_CREDENTIAL),
      CODEX_MODEL,
      "q",
      5,
      AbortSignal.timeout(5_000),
      providerFetch({ codex: () => new Response("", { status: 200 }) }),
    );

    expect(result.text).toContain("（订阅搜索不可用：没有返回内容）");
    expect(result.text).toContain("Exa result");
  });

  it("reports a timeout and never reaches the fallback", async () => {
    const calls: RecordedCall[] = [];
    const controller = new AbortController();
    controller.abort();

    const result = await searchWebWithModel(
      subscriptionEnv(LIVE_CREDENTIAL),
      CODEX_MODEL,
      "q",
      5,
      controller.signal,
      providerFetch(
        {
          codex: () => {
            throw new Error("must not be called");
          },
        },
        calls,
      ),
    );

    expect(result).toEqual({ ok: false, text: "搜索超时：超过 30 秒" });
    expect(calls).toEqual([]);
  });

  it("does not touch the subscription for a model outside it", async () => {
    const calls: RecordedCall[] = [];
    const result = await searchWebWithModel(
      subscriptionEnv(LIVE_CREDENTIAL),
      { provider: "deepseek", id: "deepseek-v4.1-flash" },
      "q",
      5,
      AbortSignal.timeout(5_000),
      providerFetch({}, calls),
    );

    expect(result.text).toContain("Exa result");
    expect(new Set(hosts(calls))).toEqual(new Set(["mcp.exa.ai"]));
  });

  it("reads the model at execute time, not at install time", async () => {
    let model: { provider: string; id: string } | undefined;
    const calls: RecordedCall[] = [];
    const tool = webSearchTool(
      subscriptionEnv(LIVE_CREDENTIAL),
      providerFetch({ codex: () => codexStream("订阅结果") }, calls),
      () => model,
    );
    model = CODEX_MODEL;

    const result = await tool.execute(
      { query: "q" },
      {} as never,
      context(new AbortController().signal),
    );

    expect(textOf(result)).toContain("订阅结果");
    expect(hosts(calls)).toEqual(["chatgpt.com"]);
  });

  it("uses the configured provider while the model is still unknown", async () => {
    const calls: RecordedCall[] = [];
    const tool = webSearchTool(
      subscriptionEnv(LIVE_CREDENTIAL),
      providerFetch({}, calls),
      () => undefined,
    );

    const result = await tool.execute(
      { query: "q" },
      {} as never,
      context(new AbortController().signal),
    );

    expect(textOf(result)).toContain("Exa result");
    expect(new Set(hosts(calls))).toEqual(new Set(["mcp.exa.ai"]));
  });
});
