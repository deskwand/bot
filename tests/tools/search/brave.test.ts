import { describe, expect, it } from "vitest";
import { braveAdapter } from "../../../src/tools/search/brave";

type RecordedCall = { input: RequestInfo | URL; init?: RequestInit };

const KEY = "brave-secret-key";

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

describe("braveAdapter", () => {
  it("sends key and query", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = recordingFetch(
      () => jsonResponse({ web: { results: [] } }),
      calls,
    );

    await braveAdapter(KEY, fakeFetch).search("hello world", 3, signal());

    const call = calls[0];
    const url = new URL(String(call.input));
    expect(url.origin + url.pathname).toBe(
      "https://api.search.brave.com/res/v1/web/search",
    );
    expect(url.searchParams.get("q")).toBe("hello world");
    expect(url.searchParams.get("count")).toBe("3");
    expect(call.init?.method ?? "GET").toBe("GET");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("x-subscription-token")).toBe(KEY);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("maps results", async () => {
    const fakeFetch = recordingFetch(() =>
      jsonResponse({
        web: {
          results: [
            { title: "A", url: "https://a", description: "x" },
            { title: "B", url: "https://b", description: "y" },
          ],
        },
      }),
    );

    await expect(
      braveAdapter(KEY, fakeFetch).search("q", 5, signal()),
    ).resolves.toEqual([
      { title: "A", url: "https://a", snippet: "x" },
      { title: "B", url: "https://b", snippet: "y" },
    ]);
  });

  it("drops results without a url", async () => {
    const fakeFetch = recordingFetch(() =>
      jsonResponse({
        web: {
          results: [
            { title: "A", url: "https://a", description: "x" },
            { title: "B", description: "y" },
          ],
        },
      }),
    );

    await expect(
      braveAdapter(KEY, fakeFetch).search("q", 5, signal()),
    ).resolves.toEqual([{ title: "A", url: "https://a", snippet: "x" }]);
  });

  it("throws on an http error without leaking the key", async () => {
    const fakeFetch = recordingFetch(() => new Response("nope", { status: 429 }));

    const error = await braveAdapter(KEY, fakeFetch)
      .search("q", 5, signal())
      .then(
        () => null,
        (reason: Error) => reason,
      );

    expect(error?.message).toBe("HTTP 429");
    expect(error?.message).not.toContain(KEY);
  });

  it("throws when the response is not json", async () => {
    const fakeFetch = recordingFetch(
      () => new Response("<html>", { status: 200 }),
    );

    await expect(
      braveAdapter(KEY, fakeFetch).search("q", 5, signal()),
    ).rejects.toThrow("响应不是 JSON");
  });

  it("treats a missing web object as no results", async () => {
    const fakeFetch = recordingFetch(() => jsonResponse({}));

    await expect(
      braveAdapter(KEY, fakeFetch).search("q", 5, signal()),
    ).resolves.toEqual([]);
  });

  it("clamps count", async () => {
    const calls: RecordedCall[] = [];
    const fakeFetch = recordingFetch(
      () => jsonResponse({ web: { results: [] } }),
      calls,
    );

    await braveAdapter(KEY, fakeFetch).search("q", 100, signal());

    const url = new URL(String(calls[0].input));
    expect(url.searchParams.get("count")).toBe("20");
  });
});
