import { describe, expect, it, vi } from "vitest";
import { binanceGet, okxGet } from "../../src/exchange/http";
import { ExchangeError, type ExchangeAccount } from "../../src/exchange/types";

const account = (venue: "okx" | "binance"): ExchangeAccount => ({
  id: "main",
  venue,
  label: "main",
  baseUrl: venue === "okx" ? "https://www.okx.com" : "https://api.binance.com",
  secret:
    venue === "okx"
      ? { key: "ok-key", secret: "test-okx-secret", passphrase: "pp" }
      : { key: "bn-key", secret: "test-binance-secret" },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("okxGet", () => {
  it("sends the four auth headers and signs the path with its query", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ code: "0", data: [{ totalEq: "1" }] }),
    );
    const data = await okxGet(
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => 1794384000000,
      },
      account("okx"),
      "/api/v5/account/balance",
      { ccy: "USDT" },
    );

    expect(data).toEqual([{ totalEq: "1" }]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://www.okx.com/api/v5/account/balance?ccy=USDT");
    expect((init as RequestInit).method).toBe("GET");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["OK-ACCESS-KEY"]).toBe("ok-key");
    expect(headers["OK-ACCESS-PASSPHRASE"]).toBe("pp");
    expect(headers["OK-ACCESS-TIMESTAMP"]).toBe("2026-11-11T08:00:00.000Z");
    expect(headers["OK-ACCESS-SIGN"]).toBe(
      "PFSzYHAgUNmjoVfphCIqx25TPKPQHcVcxCY3FG4cPTw=",
    );
  });

  it("turns a 50113 envelope into the signature bucket", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ code: "50113", msg: "Invalid Sign", data: [] }),
    );
    await expect(
      okxGet(
        { fetchImpl: fetchImpl as unknown as typeof fetch },
        account("okx"),
        "/api/v5/account/balance",
      ),
    ).rejects.toMatchObject({ name: "ExchangeError", bucket: "signature" });
  });

  it("turns 50119 into the wrongDomain bucket", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ code: "50119", msg: "API key doesn't exist", data: [] }),
    );
    await expect(
      okxGet(
        { fetchImpl: fetchImpl as unknown as typeof fetch },
        account("okx"),
        "/api/v5/account/balance",
      ),
    ).rejects.toMatchObject({ bucket: "wrongDomain" });
  });

  it("treats an unknown envelope code as a failure, never as success", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ code: "51010", msg: "not enabled", data: [] }),
    );
    await expect(
      okxGet(
        { fetchImpl: fetchImpl as unknown as typeof fetch },
        account("okx"),
        "/api/v5/account/balance",
      ),
    ).rejects.toMatchObject({ bucket: "refused", code: "51010" });
  });
});

describe("binanceGet", () => {
  it("appends the signature last and signs the raw query string", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ balances: [] }),
    );
    await binanceGet(
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => 1700000000000,
      },
      account("binance"),
      "/api/v3/account",
      { omitZeroBalances: "true" },
    );

    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v3/account");
    expect(url.searchParams.get("timestamp")).toBe("1700000000000");
    expect(url.searchParams.get("recvWindow")).toBe("5000");
    expect(url.searchParams.get("omitZeroBalances")).toBe("true");
    const signature = url.searchParams.get("signature");
    expect(signature).toBe(
      "fff769b435ccbb9ec8bdae742a4d817bb94b861bb257e97f5f070b1c896efcce",
    );
    expect(url.search.endsWith(`&signature=${signature}`)).toBe(true);
  });

  it("routes futures and coin-M paths to their own hosts by default", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({}),
    );
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch };
    await binanceGet(deps, account("binance"), "/fapi/v3/account");
    await binanceGet(deps, account("binance"), "/dapi/v1/account");
    expect(fetchImpl.mock.calls[0]![0]).toContain(
      "https://fapi.binance.com/fapi/v3/account",
    );
    expect(fetchImpl.mock.calls[1]![0]).toContain(
      "https://dapi.binance.com/dapi/v1/account",
    );
  });

  it("keeps a custom baseUrl for every path", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({}),
    );
    const proxy = { ...account("binance"), baseUrl: "https://bn.example.com" };
    await binanceGet(
      { fetchImpl: fetchImpl as unknown as typeof fetch },
      proxy,
      "/fapi/v3/account",
    );
    expect(fetchImpl.mock.calls[0]![0]).toMatch(
      /^https:\/\/bn\.example\.com\/fapi\/v3\/account\?timestamp=/,
    );
  });

  it("classifies 451 as the region bucket", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("Service unavailable from a restricted location", {
          status: 451,
        }),
    );
    await expect(
      binanceGet(
        { fetchImpl: fetchImpl as unknown as typeof fetch },
        account("binance"),
        "/api/v3/account",
      ),
    ).rejects.toMatchObject({ bucket: "region", status: 451 });
  });

  it("classifies -1021 as the timestamp bucket", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(
          {
            code: -1021,
            msg: "Timestamp for this request is outside of the recvWindow.",
          },
          400,
        ),
    );
    await expect(
      binanceGet(
        { fetchImpl: fetchImpl as unknown as typeof fetch },
        account("binance"),
        "/api/v3/account",
      ),
    ).rejects.toMatchObject({ bucket: "timestamp" });
  });

  it("uses GET everywhere except the allowlisted read-only POST path", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({}),
    );
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch };
    await binanceGet(deps, account("binance"), "/api/v3/account");
    await binanceGet(
      deps,
      account("binance"),
      "/sapi/v1/asset/get-funding-asset",
    );
    const [get, post] = fetchImpl.mock.calls;
    expect((get![1] as RequestInit).method).toBe("GET");
    expect((post![1] as RequestInit).method).toBe("POST");
  });

  it("never puts the response body in the error message", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("SECRET-LEAK", { status: 500 }),
    );
    await expect(
      binanceGet(
        { fetchImpl: fetchImpl as unknown as typeof fetch },
        account("binance"),
        "/api/v3/account",
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ExchangeError &&
        !error.message.includes("SECRET-LEAK"),
    );
  });
});
