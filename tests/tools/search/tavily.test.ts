import { describe, expect, it } from "vitest";
import { tavilyAdapter } from "../../../src/tools/search/tavily";

type RecordedCall = { input: RequestInfo | URL; init?: RequestInit };

const KEY = "tvly-secret-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(
  response: () => Response,
  calls: RecordedCall[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return response();
  }) as typeof fetch;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("tavilyAdapter", () => {
  it("sends key and query", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = recordingFetch(
      () => jsonResponse({ results: [] }),
      calls,
    );

    await tavilyAdapter(KEY, fakeFetch).search("hello", 3, signal());

    const call = calls[0];
    expect(String(call.input)).toBe("https://api.tavily.com/search");
    expect(call.init?.method).toBe("POST");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call.init?.body))).toEqual({
      query: "hello",
      max_results: 3,
      search_depth: "basic",
    });
  });

  it("maps results", async () => {
    const fakeFetch = recordingFetch(() =>
      jsonResponse({
        results: [
          { title: "A", url: "https://a", content: "x" },
          { title: "B", url: "https://b", content: "y" },
        ],
      }),
    );

    await expect(
      tavilyAdapter(KEY, fakeFetch).search("q", 5, signal()),
    ).resolves.toEqual([
      { title: "A", url: "https://a", snippet: "x" },
      { title: "B", url: "https://b", snippet: "y" },
    ]);
  });

  it("drops results without a url", async () => {
    const fakeFetch = recordingFetch(() =>
      jsonResponse({
        results: [
          { title: "A", url: "https://a", content: "x" },
          { title: "B", content: "y" },
        ],
      }),
    );

    await expect(
      tavilyAdapter(KEY, fakeFetch).search("q", 5, signal()),
    ).resolves.toEqual([{ title: "A", url: "https://a", snippet: "x" }]);
  });

  it("throws on an http error without leaking the key", async () => {
    const fakeFetch = recordingFetch(() => new Response("nope", { status: 429 }));

    const error = await tavilyAdapter(KEY, fakeFetch)
      .search("q", 5, signal())
      .then(
        () => null,
        (reason: Error) => reason,
      );

    expect(error?.message).toBe("HTTP 429");
    expect(error?.message).not.toContain(KEY);
  });

  it("throws when the response body is malformed", async () => {
    const fakeFetch = recordingFetch(() => jsonResponse({ detail: "x" }));

    await expect(
      tavilyAdapter(KEY, fakeFetch).search("q", 5, signal()),
    ).rejects.toThrow("响应格式不对");
  });

  it("throws when the response is not json", async () => {
    const fakeFetch = recordingFetch(
      () => new Response("<html>", { status: 200 }),
    );

    await expect(
      tavilyAdapter(KEY, fakeFetch).search("q", 5, signal()),
    ).rejects.toThrow("响应不是 JSON");
  });

  it("clamps count", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = recordingFetch(
      () => jsonResponse({ results: [] }),
      calls,
    );

    await tavilyAdapter(KEY, fakeFetch).search("q", 100, signal());

    expect(JSON.parse(String(calls[0].init?.body)).max_results).toBe(20);
  });
});
