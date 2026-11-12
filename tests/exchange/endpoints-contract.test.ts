import { describe, expect, it } from "vitest";
import { binanceAdapter } from "../../src/exchange/binance";
import { BINANCE_ENDPOINTS } from "../../src/exchange/replay";
import { BUCKETS, type ExchangeAccount } from "../../src/exchange/types";

const account: ExchangeAccount = {
  id: "bn-main",
  venue: "binance",
  label: "Binance 主号",
  baseUrl: "https://api.binance.com",
  secret: { key: "k", secret: "s" },
};

type Seen = {
  method: string;
  path: string;
  params: Record<string, string>;
};

const UNSIGNED = new Set(["timestamp", "recvWindow", "signature"]);

function recording() {
  const seen: Seen[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!UNSIGNED.has(key)) params[key] = value;
    }
    seen.push({
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      params,
    });
    const list =
      url.pathname === "/api/v3/ticker/price" ||
      url.pathname === "/fapi/v3/positionRisk";
    return new Response(list ? "[]" : "{}", { status: 200 });
  };
  return { seen, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function canonical(list: readonly Seen[]): string[] {
  return list.map((entry) => JSON.stringify(entry)).sort();
}

describe("Binance endpoint contract", () => {
  it("fetches exactly the endpoints in the contract", async () => {
    const { seen, fetchImpl } = recording();
    await binanceAdapter.fetch(
      account,
      { include: [...BUCKETS, "positions"] },
      undefined,
      { fetchImpl },
    );

    expect(canonical(seen)).toEqual(canonical(BINANCE_ENDPOINTS));
  });
});
