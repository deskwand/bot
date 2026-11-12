import { describe, expect, it } from "vitest";
import { binanceAdapter } from "../../src/exchange/binance";
import type { ExchangeAccount } from "../../src/exchange/types";

const account: ExchangeAccount = {
  id: "bn-main",
  venue: "binance",
  label: "Binance 主号",
  baseUrl: "https://api.binance.com",
  secret: { key: "k", secret: "s" },
};

function fetchOf(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const methods: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    methods.push(init?.method ?? "GET");
    if (!Object.hasOwn(routes, url.pathname)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(routes[url.pathname]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, methods, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const prices = [
  { symbol: "BTCUSDT", price: "65500" },
  { symbol: "BNBUSDT", price: "166.67" },
];

describe("binanceAdapter", () => {
  it("adds free and locked balances and values them from ticker prices", async () => {
    const { fetchImpl } = fetchOf({
      "/api/v3/ticker/price": prices,
      "/api/v3/account": {
        balances: [
          { asset: "USDT", free: "1500", locked: "0" },
          { asset: "BNB", free: "3", locked: "0.5" },
          { asset: "ETH", free: "0", locked: "0" },
        ],
      },
    });
    const snapshot = await binanceAdapter.fetch(
      account,
      { include: ["spot"] },
      undefined,
      { fetchImpl },
    );

    const [spot] = snapshot.buckets;
    expect(spot!.bucket).toBe("spot");
    expect(spot!.balances.map((item) => [item.ccy, item.amount])).toEqual([
      ["USDT", 1500],
      ["BNB", 3.5],
    ]);
    // 3.5 × 166.67 = 583.345, so the expectation keeps three decimals.
    expect(spot!.balances[1]!.value).toBeCloseTo(583.345, 3);
    expect(spot!.value).toBeCloseTo(2083.345, 3);
    expect(snapshot.total).toBeCloseTo(2083.345, 3);
  });

  it("asks for non-zero spot balances only", async () => {
    const { calls, fetchImpl } = fetchOf({
      "/api/v3/ticker/price": prices,
      "/api/v3/account": { balances: [] },
    });
    await binanceAdapter.fetch(account, { include: ["spot"] }, undefined, {
      fetchImpl,
    });
    expect(calls.some((call) => call.includes("omitZeroBalances=true"))).toBe(
      true,
    );
  });

  it("uses netAsset for margin instead of totalAsset", async () => {
    const { calls, fetchImpl } = fetchOf({
      "/api/v3/ticker/price": prices,
      "/api/v3/account": { balances: [] },
      "/sapi/v1/margin/account": {
        totalAssetOfBtc: "1",
        userAssets: [
          {
            asset: "USDT",
            free: "200",
            locked: "0",
            borrowed: "100",
            netAsset: "100",
          },
        ],
      },
      "/sapi/v1/margin/isolated/account": { assets: [] },
    });
    const snapshot = await binanceAdapter.fetch(
      account,
      { include: ["margin"] },
      undefined,
      { fetchImpl },
    );
    expect(snapshot.buckets[0]).toEqual({
      bucket: "margin",
      value: 100,
      balances: [{ ccy: "USDT", amount: 100, value: 100, bucket: "margin" }],
    });
    expect(calls.some((call) => call.startsWith("/api/v3/account"))).toBe(false);
  });

  it("reads the futures wallet balance and its positions", async () => {
    const { fetchImpl } = fetchOf({
      "/api/v3/ticker/price": prices,
      "/fapi/v3/account": {
        totalMarginBalance: "900.5",
        assets: [{ asset: "USDT", balance: "900.5" }],
      },
      "/fapi/v3/positionRisk": [
        {
          symbol: "BTCUSDT",
          positionAmt: "0.01",
          entryPrice: "61800",
          markPrice: "63200",
          unRealizedProfit: "14",
          liquidationPrice: "30100",
          leverage: "10",
        },
      ],
    });
    const snapshot = await binanceAdapter.fetch(
      account,
      { include: ["futures"] },
      undefined,
      { fetchImpl },
    );

    expect(snapshot.buckets).toEqual([
      {
        bucket: "futures",
        value: 900.5,
        balances: [
          { ccy: "USDT", amount: 900.5, value: 900.5, bucket: "futures" },
        ],
      },
    ]);
    expect(snapshot.positions[0]).toMatchObject({
      instrument: "BTCUSDT",
      kind: "futures",
      side: "long",
      qty: 0.01,
      entry: 61800,
      upl: 14,
      liq: 30100,
    });
  });

  it("keeps an empty Simple Earn bucket when both products answer", async () => {
    const { fetchImpl } = fetchOf({
      "/api/v3/ticker/price": prices,
      "/api/v3/account": { balances: [{ asset: "USDT", free: "10", locked: "0" }] },
      "/sapi/v1/simple-earn/flexible/position": { rows: [] },
      "/sapi/v1/simple-earn/locked/position": { rows: [] },
    });
    const snapshot = await binanceAdapter.fetch(
      account,
      { include: ["spot", "earn"] },
      undefined,
      { fetchImpl },
    );
    expect(snapshot.buckets.map((bucket) => bucket.bucket)).toEqual([
      "spot",
      "earn",
    ]);
    expect(snapshot.degraded).toEqual([]);
  });

  it("reads the funding wallet through the allowlisted POST read", async () => {
    const { calls, methods, fetchImpl } = fetchOf({
      "/api/v3/ticker/price": prices,
      "/sapi/v1/asset/get-funding-asset": [
        { asset: "USDT", free: "120", locked: "0" },
      ],
    });
    const snapshot = await binanceAdapter.fetch(
      account,
      { include: ["funding"] },
      undefined,
      { fetchImpl },
    );

    const index = calls.findIndex((call) =>
      call.startsWith("/sapi/v1/asset/get-funding-asset"),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(methods[index]).toBe("POST");
    expect(snapshot.buckets).toEqual([
      {
        bucket: "funding",
        value: 120,
        balances: [
          { ccy: "USDT", amount: 120, value: 120, bucket: "funding" },
        ],
      },
    ]);
  });

  it("asks for the maximum Simple Earn page size", async () => {
    const { calls, fetchImpl } = fetchOf({
      "/api/v3/ticker/price": prices,
      "/sapi/v1/simple-earn/flexible/position": { rows: [] },
      "/sapi/v1/simple-earn/locked/position": { rows: [] },
    });
    await binanceAdapter.fetch(account, { include: ["earn"] }, undefined, {
      fetchImpl,
    });
    const earn = calls.filter((call) => call.includes("simple-earn"));
    expect(earn).toHaveLength(2);
    for (const call of earn) expect(call).toContain("size=100");
  });

  it("propagates 451 from the spot endpoint", async () => {
    const fetchImpl = async () =>
      new Response("Service unavailable from a restricted location", {
        status: 451,
      });
    await expect(
      binanceAdapter.fetch(account, { include: ["spot"] }, undefined, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ bucket: "region" });
  });

  it("keeps spot data when a futures endpoint refuses a key with no futures permission", async () => {
    // A read-only key sees -2015 on every futures endpoint it has no permission
    // for. The spot call already proved the key works, so only those parts go.
    const denied = JSON.stringify({
      code: -2015,
      msg: "Invalid API-key, IP, or permissions for action",
    });
    const fetchImpl = async (input: string | URL | Request) => {
      const { pathname } = new URL(String(input));
      if (pathname === "/api/v3/account") {
        return new Response(
          JSON.stringify({
            balances: [{ asset: "USDT", free: "10", locked: "0" }],
          }),
          { status: 200 },
        );
      }
      if (pathname === "/api/v3/ticker/price") {
        return new Response(JSON.stringify(prices), { status: 200 });
      }
      return new Response(denied, { status: 401 });
    };

    const snapshot = await binanceAdapter.fetch(
      account,
      { include: ["spot", "futures", "positions"] },
      undefined,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(snapshot.buckets.map((bucket) => bucket.bucket)).toEqual(["spot"]);
    // Not "unknownKey": the key just read spot, so it is the futures product
    // that is missing, not this key. Saying otherwise sends the owner off to
    // regenerate a working key.
    expect(snapshot.degraded).toEqual([
      { part: "futures", reason: "refused" },
      { part: "positions", reason: "refused" },
    ]);
    expect(snapshot.total).toBe(10);
  });

  it("rejects the whole account when the primary endpoint refuses the key", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          code: -2015,
          msg: "Invalid API-key, IP, or permissions for action",
        }),
        { status: 401 },
      );

    await expect(
      binanceAdapter.fetch(account, { include: ["spot"] }, undefined, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ bucket: "unknownKey" });
  });

  it("proves the key through the primary call when spot was not requested", async () => {
    const seen: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const { pathname } = new URL(String(input));
      seen.push(pathname);
      if (pathname === "/api/v3/ticker/price") {
        return new Response("[]", { status: 200 });
      }
      if (pathname === "/api/v3/account") {
        return new Response(JSON.stringify({ balances: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ code: -2015, msg: "no permission" }),
        { status: 401 },
      );
    };

    const snapshot = await binanceAdapter.fetch(
      account,
      { include: ["futures"] },
      undefined,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(seen).toContain("/api/v3/account");
    expect(snapshot.buckets).toEqual([]);
    // The futures block reads positions as well, so both parts degrade.
    expect(snapshot.degraded).toEqual([
      { part: "futures", reason: "refused" },
      { part: "positions", reason: "refused" },
    ]);
  });

  it("rejects a read that never proved the key", async () => {
    // No spot in the include set, and the key is revoked: without the proof
    // call this would report an empty account instead of a bad key.
    const fetchImpl = async (input: string | URL | Request) => {
      const { pathname } = new URL(String(input));
      if (pathname === "/api/v3/ticker/price") {
        return new Response("[]", { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: -2015,
          msg: "Invalid API-key, IP, or permissions for action",
        }),
        { status: 401 },
      );
    };

    await expect(
      binanceAdapter.fetch(account, { include: ["futures"] }, undefined, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ bucket: "unknownKey" });
  });
});
