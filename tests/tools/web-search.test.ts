import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { webSearchTool } from "../../src/tools/web-search";

type RecordedCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
  body: Record<string, unknown>;
};

function context(signal?: AbortSignal): Context {
  return { abortSignal: signal } as unknown as Context;
}

function textOf(result: ToolExecutionResult): string {
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
    const tool = webSearchTool(fakeFetch);
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

    const result = await webSearchTool(fakeFetch).execute(
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

    const result = await webSearchTool(fakeFetch).execute(
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

    const result = await webSearchTool(fakeFetch).execute(
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

      const result = await webSearchTool(fakeFetch).execute(
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

    const tool = webSearchTool(fakeFetch);
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

    await webSearchTool(fakeFetch).execute(
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
      await webSearchTool(fakeFetch).execute(
        { query: "q" },
        {} as never,
        context(),
      ),
    );

    expect(text).toHaveLength(20_000 + "\n\n[已截断]".length);
    expect(text.endsWith("[已截断]")).toBe(true);
  });
});
