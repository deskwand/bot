import { describe, expect, it, vi } from "vitest";
import { ingestSnapshot, parseSyncBundle } from "../../src/exchange/ingest";
import type { VenueSnapshot } from "../../src/exchange/types";

const base = {
  schemaVersion: 1,
  owner: { telegramUserIds: [] },
  models: {
    butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  },
  mcpServers: [],
};

function envWith(accounts: unknown[], secrets: Record<string, string> = {}): Env {
  return {
    DESKWAND_CONFIG: { ...base, exchange: { accounts } },
    ...secrets,
  } as unknown as Env;
}

const binanceAccount = { id: "bn-main", venue: "binance" };
const binanceSecret = '{"key":"k","secret":"s"}';

function bundle(
  account: string,
  responses: unknown[],
  fetchedAt = 1000,
): unknown {
  return { account, fetchedAt, responses };
}

function primary(status: number, body: string) {
  return { method: "GET", path: "/api/v3/account", status, body };
}

function successResponses(): unknown[] {
  return [
    {
      method: "GET",
      path: "/api/v3/account",
      status: 200,
      body: JSON.stringify({
        balances: [{ asset: "USDT", free: "10", locked: "0" }],
      }),
    },
    {
      method: "GET",
      path: "/api/v3/ticker/price",
      status: 200,
      body: "[]",
    },
  ];
}

describe("parseSyncBundle", () => {
  it("accepts a well-formed bundle", () => {
    expect(
      parseSyncBundle(bundle("bn-main", successResponses())),
    ).toMatchObject({ account: "bn-main", fetchedAt: 1000 });
  });

  it("rejects a path outside the endpoint list", () => {
    expect(
      parseSyncBundle(
        bundle("bn-main", [
          { method: "GET", path: "/api/v3/order", status: 200, body: "{}" },
        ]),
      ),
    ).toBeNull();
  });

  it("rejects an empty response list", () => {
    expect(parseSyncBundle(bundle("bn-main", []))).toBeNull();
  });

  it("rejects a status that is not an integer in 0..599", () => {
    expect(
      parseSyncBundle(
        bundle("bn-main", [
          { method: "GET", path: "/api/v3/account", status: 600, body: "{}" },
        ]),
      ),
    ).toBeNull();
  });
});

describe("ingestSnapshot", () => {
  it("rejects a path outside the endpoint list", async () => {
    const result = await ingestSnapshot(
      envWith([binanceAccount]),
      bundle("bn-main", [
        { method: "GET", path: "/api/v3/order", status: 200, body: "{}" },
      ]),
      { locale: "zh", store: async () => true },
    );
    expect(result).toMatchObject({ ok: false, code: "EXCHANGE_INVALID" });
  });

  it("rejects an account that is not configured", async () => {
    const store = vi.fn<
      (snapshot: VenueSnapshot) => Promise<boolean>
    >(async () => true);
    const result = await ingestSnapshot(
      envWith([binanceAccount]),
      bundle("bn-other", successResponses()),
      { locale: "zh", store },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "EXCHANGE_ACCOUNT_UNKNOWN",
    });
    expect(result.ok === false && result.message).toContain("bn-other");
    expect(store).not.toHaveBeenCalled();
  });

  it("rejects an OKX account", async () => {
    const store = vi.fn<
      (snapshot: VenueSnapshot) => Promise<boolean>
    >(async () => true);
    const result = await ingestSnapshot(
      envWith([{ id: "okx-main", venue: "okx" }]),
      bundle("okx-main", successResponses()),
      { locale: "zh", store },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "EXCHANGE_SYNC_UNSUPPORTED",
    });
    expect(store).not.toHaveBeenCalled();
  });

  it("does not store when the primary endpoint says -2015", async () => {
    const store = vi.fn<
      (snapshot: VenueSnapshot) => Promise<boolean>
    >(async () => true);
    const result = await ingestSnapshot(
      envWith([binanceAccount], { EXCHANGE_SECRET_BN_MAIN: binanceSecret }),
      bundle("bn-main", [
        primary(400, JSON.stringify({ code: -2015, msg: "Invalid API-key" })),
      ]),
      { locale: "zh", store },
    );
    expect(result).toMatchObject({ ok: false, code: "EXCHANGE_UNKNOWN_KEY" });
    expect(store).not.toHaveBeenCalled();
  });

  it("stores the parsed snapshot and reports currencies and total", async () => {
    const store = vi.fn<
      (snapshot: VenueSnapshot) => Promise<boolean>
    >(async () => true);
    const result = await ingestSnapshot(
      envWith([binanceAccount], { EXCHANGE_SECRET_BN_MAIN: binanceSecret }),
      bundle("bn-main", successResponses()),
      { locale: "zh", now: () => 5000, store },
    );
    expect(result).toEqual({
      ok: true,
      venue: "binance",
      currencies: 1,
      total: 10,
    });
    expect(store).toHaveBeenCalledTimes(1);
    const stored = store.mock.calls[0]?.[0] as VenueSnapshot;
    expect(stored).toMatchObject({
      venue: "binance",
      account: "bn-main",
      fetchedAt: 1000,
      total: 10,
    });
  });

  it("clamps a future fetchedAt to now", async () => {
    const store = vi.fn<
      (snapshot: VenueSnapshot) => Promise<boolean>
    >(async () => true);
    const now = 5000;
    await ingestSnapshot(
      envWith([binanceAccount]),
      bundle("bn-main", successResponses(), now + 60_000),
      { locale: "zh", now: () => now, store },
    );
    const stored = store.mock.calls[0]?.[0] as VenueSnapshot;
    expect(stored.fetchedAt).toBe(now);
  });

  it("accepts an account without a Worker secret", async () => {
    const store = vi.fn<
      (snapshot: VenueSnapshot) => Promise<boolean>
    >(async () => true);
    const result = await ingestSnapshot(
      envWith([binanceAccount]),
      bundle("bn-main", successResponses()),
      { locale: "zh", now: () => 5000, store },
    );
    expect(result).toMatchObject({ ok: true, venue: "binance" });
    expect(store).toHaveBeenCalledTimes(1);
  });

  it("does not store when the primary endpoint says 429", async () => {
    const store = vi.fn<
      (snapshot: VenueSnapshot) => Promise<boolean>
    >(async () => true);
    const result = await ingestSnapshot(
      envWith([binanceAccount]),
      bundle("bn-main", [primary(429, "{}")]),
      { locale: "zh", store },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "EXCHANGE_RATE_LIMITED",
    });
    expect(store).not.toHaveBeenCalled();
  });

  it("does not store when the primary endpoint says 451", async () => {
    const store = vi.fn<
      (snapshot: VenueSnapshot) => Promise<boolean>
    >(async () => true);
    const result = await ingestSnapshot(
      envWith([binanceAccount]),
      bundle("bn-main", [primary(451, "Service unavailable")]),
      { locale: "zh", store },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "EXCHANGE_REGION_BLOCKED",
    });
    expect(store).not.toHaveBeenCalled();
  });
});
