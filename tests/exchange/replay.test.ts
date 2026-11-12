import { describe, expect, it } from "vitest";
import { binanceAdapter } from "../../src/exchange/binance";
import { replayFetch, type RecordedResponse } from "../../src/exchange/replay";
import {
  BUCKETS,
  type ExchangeAccount,
} from "../../src/exchange/types";

const account: ExchangeAccount = {
  id: "bn-main",
  venue: "binance",
  label: "Binance 主号",
  baseUrl: "https://api.binance.com",
  secret: { key: "k", secret: "s" },
};

function recorded(
  method: string,
  path: string,
  status: number,
  body = "",
): RecordedResponse {
  return { method, path, status, body };
}

describe("replayFetch", () => {
  it("matches by method and path, ignoring host and query", async () => {
    const f = replayFetch([
      recorded("GET", "/api/v3/account", 200, '{"balances":[]}'),
    ]);
    const r = await f(
      "https://api.binance.com/api/v3/account?timestamp=1&recvWindow=5000&omitZeroBalances=true&signature=ab",
      { method: "GET" },
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"balances":[]}');
  });

  it("passes the recorded status through", async () => {
    const f = replayFetch([
      recorded("GET", "/api/v3/account", 400, '{"code":-2015}'),
    ]);
    const r = await f("https://api.binance.com/api/v3/account", {
      method: "GET",
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toBe('{"code":-2015}');
  });

  it("throws a TypeError for status 0", async () => {
    const f = replayFetch([recorded("GET", "/api/v3/account", 0)]);
    await expect(
      f("https://api.binance.com/api/v3/account", { method: "GET" }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("throws a TypeError for a path that was not recorded", async () => {
    const f = replayFetch([recorded("GET", "/api/v3/account", 200, "{}")]);
    await expect(
      f("https://api.binance.com/api/v3/ticker/price", { method: "GET" }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("does not match a GET recording for a POST request", async () => {
    const f = replayFetch([recorded("GET", "/api/v3/account", 200, "{}")]);
    await expect(
      f("https://api.binance.com/api/v3/account", { method: "POST" }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("replays a full bundle through binanceAdapter, degrading a 4xx earn endpoint", async () => {
    const bundle: RecordedResponse[] = [
      recorded(
        "GET",
        "/api/v3/account",
        200,
        JSON.stringify({
          balances: [{ asset: "USDT", free: "10", locked: "0" }],
        }),
      ),
      recorded("GET", "/api/v3/ticker/price", 200, "[]"),
      recorded("POST", "/sapi/v1/asset/get-funding-asset", 0),
      recorded("GET", "/sapi/v1/margin/account", 0),
      recorded("GET", "/sapi/v1/margin/isolated/account", 0),
      recorded("GET", "/fapi/v3/account", 0),
      recorded("GET", "/fapi/v3/positionRisk", 0),
      recorded("GET", "/dapi/v1/account", 0),
      recorded(
        "GET",
        "/sapi/v1/simple-earn/flexible/position",
        400,
        '{"code":-12345}',
      ),
      recorded("GET", "/sapi/v1/simple-earn/locked/position", 0),
    ];
    const snapshot = await binanceAdapter.fetch(
      account,
      { include: [...BUCKETS, "positions"] },
      undefined,
      { fetchImpl: replayFetch(bundle), now: () => 1000 },
    );

    expect(snapshot.fetchedAt).toBe(1000);
    const spot = snapshot.buckets.find((bucket) => bucket.bucket === "spot");
    expect(spot?.value).toBe(10);
    expect(snapshot.degraded).toContainEqual({ part: "earn", reason: "network" });
    expect(snapshot.degraded).toContainEqual({
      part: "funding",
      reason: "network",
    });
  });
});
