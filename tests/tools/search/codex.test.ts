import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_PROVIDER_ID } from "../../../src/llm/codex";
import {
  deleteModelCredential,
  saveModelCredential,
} from "../../../src/llm/model-auth";
import { subscriptionSearch } from "../../../src/tools/search/codex";
import { fakeCodexToken } from "../../helpers/codex-token";

const MODEL = { provider: CODEX_PROVIDER_ID, id: "gpt-6.2-sol" };
const URL_UNDER_TEST = "https://chatgpt.com/backend-api/codex/responses";

type RecordedCall = { input: RequestInfo | URL; init?: RequestInit };

/** A live credential, so no test here reaches the refresh endpoint. */
async function signIn(): Promise<void> {
  await saveModelCredential(env, CODEX_PROVIDER_ID, {
    type: "oauth",
    access: fakeCodexToken(),
    refresh: "refresh-0",
    expires: Date.now() + 3_600_000,
  });
}

function stream(events: unknown[]): Response {
  return new Response(
    events
      .map(
        (event) =>
          `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function answer(
  text: string,
  citations: Array<{ title: string; url: string }> = [],
): unknown[] {
  return [
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
}

function recordingFetch(
  respond: () => Response,
  calls: RecordedCall[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return respond();
  }) as typeof fetch;
}

afterEach(async () => {
  await deleteModelCredential(env, CODEX_PROVIDER_ID);
});

describe("subscriptionSearch", () => {
  it("declares the hosted tool and returns the answer as one snippet", async () => {
    await signIn();
    const calls: RecordedCall[] = [];
    const fakeFetch = recordingFetch(
      () =>
        stream(
          answer("1 BTC 约 58,132 美元。", [
            {
              title: "CoinMarketCap",
              url: "https://coinmarketcap.com/currencies/bitcoin/",
            },
          ]),
        ),
      calls,
    );

    const results = await subscriptionSearch(
      env,
      MODEL,
      "bitcoin price",
      AbortSignal.timeout(5_000),
      fakeFetch,
    );

    expect(String(calls[0]?.input)).toBe(URL_UNDER_TEST);
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("originator")).toBe("pi");
    expect(headers.get("chatgpt-account-id")).toBe("acct-1");
    expect(headers.get("authorization")).toMatch(/^Bearer /);
    expect(headers.get("user-agent")).toBeNull();

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "gpt-6.2-sol",
      store: false,
      stream: true,
      instructions: expect.stringContaining("web_search"),
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      input: [
        { role: "user", content: [{ type: "input_text", text: "bitcoin price" }] },
      ],
    });

    expect(results).toEqual([
      {
        title: "",
        url: "",
        snippet:
          "1 BTC 约 58,132 美元。\n\n来源：\n- CoinMarketCap https://coinmarketcap.com/currencies/bitcoin/",
      },
    ]);
  });

  it("does not list a source the answer already links", async () => {
    await signIn();
    const url = "https://coinmarketcap.com/currencies/bitcoin/";
    const results = await subscriptionSearch(
      env,
      MODEL,
      "bitcoin price",
      AbortSignal.timeout(5_000),
      recordingFetch(() =>
        stream(answer(`价格见 [CoinMarketCap](${url})`, [{ title: "CMC", url }])),
      ),
    );

    expect(results[0]?.snippet).toBe(`价格见 [CoinMarketCap](${url})`);
  });

  it("adds no sources section when the answer cites nothing", async () => {
    await signIn();
    const results = await subscriptionSearch(
      env,
      MODEL,
      "bitcoin price",
      AbortSignal.timeout(5_000),
      recordingFetch(() => stream(answer("没法查。"))),
    );

    expect(results[0]?.snippet).toBe("没法查。");
  });

  it("fails with the status alone when Cloudflare answers with a web page", async () => {
    await signIn();
    const fakeFetch = recordingFetch(
      () =>
        new Response("<html>Unable to load site</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    );

    await expect(
      subscriptionSearch(env, MODEL, "q", AbortSignal.timeout(5_000), fakeFetch),
    ).rejects.toThrow("Codex 搜索返回 HTTP 403");
  });

  it("fails with the backend message buried in the stream", async () => {
    await signIn();
    const fakeFetch = recordingFetch(() =>
      stream([
        {
          type: "response.failed",
          response: {
            error: { message: "web search is not available for this account" },
          },
        },
      ]),
    );

    await expect(
      subscriptionSearch(env, MODEL, "q", AbortSignal.timeout(5_000), fakeFetch),
    ).rejects.toThrow("web search is not available for this account");
  });

  it("never reports undefined when the error event carries no message", async () => {
    await signIn();
    const fakeFetch = recordingFetch(() => stream([{ type: "error" }]));

    await expect(
      subscriptionSearch(env, MODEL, "q", AbortSignal.timeout(5_000), fakeFetch),
    ).rejects.toThrow("Codex 搜索失败：error");
  });

  it("returns no results for a stream without an answer", async () => {
    await signIn();
    const fakeFetch = recordingFetch(() =>
      stream([{ type: "response.completed" }]),
    );

    expect(
      await subscriptionSearch(env, MODEL, "q", AbortSignal.timeout(5_000), fakeFetch),
    ).toEqual([]);
  });

  it("ignores frames that are not JSON", async () => {
    await signIn();
    const fakeFetch = recordingFetch(
      () =>
        new Response(
          `: keep-alive\n\ndata: not-json\n\ndata: ${JSON.stringify(answer("ok")[0])}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );

    const results = await subscriptionSearch(
      env,
      MODEL,
      "q",
      AbortSignal.timeout(5_000),
      fakeFetch,
    );
    expect(results[0]?.snippet).toBe("ok");
  });

  it("fails when there is no subscription to use", async () => {
    await deleteModelCredential(env, CODEX_PROVIDER_ID);
    const fakeFetch = recordingFetch(() => stream(answer("never")));

    await expect(
      subscriptionSearch(env, MODEL, "q", AbortSignal.timeout(5_000), fakeFetch),
    ).rejects.toThrow("没有可用的 Codex 授权");
  });
});
