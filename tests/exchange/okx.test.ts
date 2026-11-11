import { describe, expect, it } from "vitest";
import { okxAdapter } from "../../src/exchange/okx";
import type { ExchangeAccount } from "../../src/exchange/types";

const account: ExchangeAccount = {
  id: "okx-main",
  venue: "okx",
  label: "OKX 主号",
  baseUrl: "https://www.okx.com",
  secret: { key: "k", secret: "s", passphrase: "p" },
};

type Route = (url: URL) => unknown;

function fetchOf(routes: Record<string, Route>) {
  const calls: URL[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const route = routes[url.pathname];
    if (route === undefined) return new Response("{}", { status: 404 });
    const body = route(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const balance = {
  code: "0",
  data: [
    {
      totalEq: "11200.5",
      details: [
        { ccy: "BTC", eq: "0.12", eqUsd: "7900.4" },
        { ccy: "USDT", eq: "3260", eqUsd: "3260" },
      ],
    },
  ],
};

const valuation = {
  code: "0",
  data: [
    {
      totalBal: "12480.5",
      details: { funding: "980", earn: "300", trading: "11200.5", classic: "0" },
    },
  ],
};

describe("okxAdapter", () => {
  it("maps the trading account into the spot bucket with a total", async () => {
    const { fetchImpl } = fetchOf({
      "/api/v5/account/balance": () => balance,
      "/api/v5/asset/asset-valuation": () => valuation,
    });
    const snapshot = await okxAdapter.fetch(
      account,
      { include: ["spot"] },
      undefined,
      { fetchImpl },
    );

    expect(snapshot.total).toBe(11200.5);
    expect(snapshot.buckets).toEqual([
      {
        bucket: "spot",
        value: 11200.5,
        balances: [
          { ccy: "BTC", amount: 0.12, value: 7900.4, bucket: "spot" },
          { ccy: "USDT", amount: 3260, value: 3260, bucket: "spot" },
        ],
      },
    ]);
    expect(snapshot.degraded).toEqual([]);
  });

  it("adds funding and earn into the account total", async () => {
    const { fetchImpl } = fetchOf({
      "/api/v5/account/balance": () => balance,
      "/api/v5/asset/asset-valuation": () => valuation,
      "/api/v5/asset/balances": () => ({
        code: "0",
        data: [{ ccy: "USDT", bal: "900" }],
      }),
      "/api/v5/finance/savings/balance": () => ({
        code: "0",
        data: [{ ccy: "USDT", amt: "300" }],
      }),
      "/api/v5/finance/staking-defi/orders-active": () => ({ code: "0", data: [] }),
    });
    const snapshot = await okxAdapter.fetch(
      account,
      { include: ["spot", "funding", "earn"] },
      undefined,
      { fetchImpl },
    );

    expect(snapshot.buckets.map((bucket) => bucket.bucket)).toEqual([
      "spot",
      "funding",
      "earn",
    ]);
    expect(snapshot.total).toBeCloseTo(12480.5, 2);
  });

  it("reads funding balances and takes their total from asset-valuation", async () => {
    const { fetchImpl } = fetchOf({
      "/api/v5/asset/balances": () => ({
        code: "0",
        data: [
          { ccy: "USDT", bal: "900" },
          { ccy: "DOGE", bal: "500" },
        ],
      }),
      "/api/v5/asset/asset-valuation": () => valuation,
    });
    const snapshot = await okxAdapter.fetch(
      account,
      { include: ["funding"] },
      undefined,
      { fetchImpl },
    );

    expect(snapshot.buckets).toEqual([
      {
        bucket: "funding",
        value: 980,
        balances: [
          { ccy: "USDT", amount: 900, bucket: "funding" },
          { ccy: "DOGE", amount: 500, bucket: "funding" },
        ],
      },
    ]);
  });

  it("maps positions with unrealized pnl and liquidation price", async () => {
    const { fetchImpl } = fetchOf({
      "/api/v5/account/positions": () => ({
        code: "0",
        data: [
          {
            instId: "BTC-USDT-SWAP",
            instType: "SWAP",
            pos: "0.05",
            posSide: "long",
            avgPx: "62000",
            markPx: "63200",
            upl: "60",
            notionalUsd: "3160",
            liqPx: "48100",
            lever: "3",
          },
        ],
      }),
    });
    const snapshot = await okxAdapter.fetch(
      account,
      { include: ["positions"] },
      undefined,
      { fetchImpl },
    );

    expect(snapshot.positions).toEqual([
      {
        instrument: "BTC-USDT-SWAP",
        kind: "swap",
        side: "long",
        qty: 0.05,
        entry: 62000,
        mark: 63200,
        notional: 3160,
        upl: 60,
        liq: 48100,
        leverage: 3,
      },
    ]);
  });

  it("degrades a failing sub-bucket instead of failing the account", async () => {
    const { fetchImpl } = fetchOf({
      "/api/v5/account/balance": () => balance,
      "/api/v5/asset/asset-valuation": () => valuation,
      "/api/v5/finance/savings/balance": () => ({
        code: "51010",
        msg: "not enabled",
        data: [],
      }),
    });
    const snapshot = await okxAdapter.fetch(
      account,
      { include: ["spot", "earn"] },
      undefined,
      { fetchImpl },
    );

    expect(snapshot.buckets.map((bucket) => bucket.bucket)).toEqual(["spot"]);
    expect(snapshot.degraded).toEqual([{ part: "earn", reason: "refused" }]);
  });

  it("propagates an auth failure from the main endpoint", async () => {
    const { fetchImpl } = fetchOf({
      "/api/v5/account/balance": () => ({
        code: "50111",
        msg: "Invalid OK-ACCESS-KEY",
        data: [],
      }),
    });
    await expect(
      okxAdapter.fetch(account, { include: ["spot"] }, undefined, { fetchImpl }),
    ).rejects.toMatchObject({ bucket: "unknownKey" });
  });

  it("treats empty-string amounts as missing, not as zero", async () => {
    const { fetchImpl } = fetchOf({
      "/api/v5/account/balance": () => ({
        code: "0",
        data: [{ totalEq: "", details: [{ ccy: "BTC", eq: "", eqUsd: "" }] }],
      }),
    });
    const snapshot = await okxAdapter.fetch(
      account,
      { include: ["spot"] },
      undefined,
      { fetchImpl },
    );
    expect(snapshot.total).toBeUndefined();
    expect(snapshot.buckets[0]!.balances).toEqual([]);
  });
});
