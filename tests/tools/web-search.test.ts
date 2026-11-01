import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { webSearchTool } from "../../src/tools/web-search";

function context(signal?: AbortSignal): Context {
  return { abortSignal: signal } as unknown as Context;
}

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

describe("webSearchTool", () => {
  it("posts to Tavily with the key and formats the results", async () => {
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Cloudflare Workers",
              url: "https://workers.cloudflare.com/",
              content: "Run code at the edge.",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const controller = new AbortController();
    const tool = webSearchTool("tvly-test-key", fakeFetch);
    const result = await tool.execute(
      { query: "cloudflare workers" },
      {} as never,
      context(controller.signal),
    );

    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe("https://api.tavily.com/search");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.signal).toBe(controller.signal);
    expect(
      new Headers(calls[0]!.init?.headers).get("authorization"),
    ).toBe("Bearer tvly-test-key");

    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      query: "cloudflare workers",
      max_results: 5,
      search_depth: "basic",
    });

    const text = textOf(result);
    expect(text).toContain("Cloudflare Workers");
    expect(text).toContain("https://workers.cloudflare.com/");
    expect(text).toContain("Run code at the edge.");
    expect(tool.replay).toBe("safe");
  });

  it("honours maxResults", async () => {
    let body: unknown;
    const fakeFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const tool = webSearchTool("key", fakeFetch);
    const result = await tool.execute(
      { query: "q", maxResults: 3 },
      {} as never,
      context(),
    );

    expect(body).toMatchObject({ max_results: 3 });
    expect(textOf(result)).toBe("没有找到搜索结果。");
  });
});
