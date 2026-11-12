import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exchangeStub } from "../../src/exchange/exchange-do";
import type { VenueSnapshot } from "../../src/exchange/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function snapshot(account: string, fetchedAt: number): VenueSnapshot {
  return {
    venue: "binance",
    account,
    fetchedAt,
    total: 10,
    buckets: [
      {
        bucket: "spot",
        value: 10,
        balances: [{ ccy: "USDT", amount: 10, value: 10, bucket: "spot" }],
      },
    ],
    positions: [],
    degraded: [],
  };
}

// The workerd pool shares storage across cases in one file, so every case uses
// its own account id.
describe("ExchangeDO", () => {
  it("returns null for an account it has never seen", async () => {
    expect(await exchangeStub(env).get("bn-do-1")).toBeNull();
  });

  it("stores and returns a snapshot by account", async () => {
    const stored = snapshot("bn-main", 1000);

    expect(await exchangeStub(env).put(stored)).toBe(true);
    expect(await exchangeStub(env).get("bn-main")).toEqual(stored);
  });

  it("keeps the newer snapshot when an older one arrives later", async () => {
    const stub = exchangeStub(env);
    expect(await stub.put(snapshot("bn-do-2", 2000))).toBe(true);
    expect(await stub.put(snapshot("bn-do-2", 1000))).toBe(false);

    expect((await stub.get("bn-do-2"))?.fetchedAt).toBe(2000);
  });

  it("keeps accounts apart", async () => {
    const stub = exchangeStub(env);
    await stub.put(snapshot("bn-a", 1000));
    await stub.put(snapshot("bn-b", 2000));

    expect((await stub.get("bn-a"))?.fetchedAt).toBe(1000);
    expect((await stub.get("bn-b"))?.fetchedAt).toBe(2000);
  });
});
