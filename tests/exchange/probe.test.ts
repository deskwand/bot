import { describe, expect, it } from "vitest";
import { probeExchange } from "../../src/exchange/probe";

const base = {
  schemaVersion: 1,
  owner: { telegramUserIds: [] },
  models: {
    butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  },
  mcpServers: [],
};

function envWith(accounts: unknown[], secrets: Record<string, string>): Env {
  return {
    DESKWAND_CONFIG: { ...base, exchange: { accounts } },
    ...secrets,
  } as unknown as Env;
}

const okxSecret = '{"key":"k","secret":"s","passphrase":"p"}';

describe("probeExchange", () => {
  it("reports an unknown account id", async () => {
    const result = await probeExchange(
      envWith([{ id: "okx-main", venue: "okx" }], {
        EXCHANGE_SECRET_OKX_MAIN: okxSecret,
      }),
      "nope",
    );
    expect(result).toMatchObject({
      ok: false,
      code: "EXCHANGE_ACCOUNT_UNKNOWN",
    });
  });

  it("reports a missing secret for a configured id", async () => {
    const result = await probeExchange(
      envWith([{ id: "bn-main", venue: "binance" }], {}),
      "bn-main",
    );
    expect(result).toMatchObject({
      ok: false,
      code: "EXCHANGE_SECRET_MISSING",
    });
  });

  it("returns the currency count and total on success", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          code: "0",
          data: [
            {
              totalEq: "12480.5",
              details: [{ ccy: "USDT", eq: "12480.5", eqUsd: "12480.5" }],
            },
          ],
        }),
        { status: 200 },
      );
    const result = await probeExchange(
      envWith([{ id: "okx-main", venue: "okx" }], {
        EXCHANGE_SECRET_OKX_MAIN: okxSecret,
      }),
      "okx-main",
      { fetchImpl: fetchImpl as unknown as typeof fetch, locale: "zh" },
    );
    expect(result).toEqual({
      ok: true,
      venue: "okx",
      currencies: 1,
      total: 12480.5,
    });
  });

  it("maps a 451 to EXCHANGE_REGION_BLOCKED", async () => {
    const fetchImpl = async () =>
      new Response("Service unavailable from a restricted location", {
        status: 451,
      });
    const result = await probeExchange(
      envWith([{ id: "bn-main", venue: "binance" }], {
        EXCHANGE_SECRET_BN_MAIN: '{"key":"k","secret":"s"}',
      }),
      "bn-main",
      { fetchImpl: fetchImpl as unknown as typeof fetch, locale: "zh" },
    );
    expect(result).toMatchObject({ ok: false, code: "EXCHANGE_REGION_BLOCKED" });
    expect(result.ok === false && result.message).toContain("受限地区");
  });

  it("maps 50119 to EXCHANGE_WRONG_DOMAIN", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ code: "50119", msg: "API key doesn't exist", data: [] }),
        { status: 200 },
      );
    const result = await probeExchange(
      envWith([{ id: "okx-main", venue: "okx" }], {
        EXCHANGE_SECRET_OKX_MAIN: okxSecret,
      }),
      "okx-main",
      { fetchImpl: fetchImpl as unknown as typeof fetch, locale: "zh" },
    );
    expect(result).toMatchObject({ ok: false, code: "EXCHANGE_WRONG_DOMAIN" });
  });
});
