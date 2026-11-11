import { describe, expect, it, vi } from "vitest";
import {
  configuredAccounts,
  normalizeBaseUrl,
  parseSecret,
  secretNameFor,
} from "../../src/exchange/accounts";

const base = {
  schemaVersion: 1,
  owner: { telegramUserIds: [] },
  models: {
    butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  },
  mcpServers: [],
};

function envWith(exchange: unknown, secrets: Record<string, string> = {}): Env {
  return { DESKWAND_CONFIG: { ...base, exchange }, ...secrets } as unknown as Env;
}

const okxSecret = JSON.stringify({ key: "k", secret: "s", passphrase: "p" });

describe("secretNameFor", () => {
  it("upper-cases the id and turns dashes into underscores", () => {
    expect(secretNameFor("okx-main")).toBe("EXCHANGE_SECRET_OKX_MAIN");
  });
});

describe("normalizeBaseUrl", () => {
  it("defaults per venue and strips a trailing slash", () => {
    expect(normalizeBaseUrl(undefined, "okx")).toBe("https://www.okx.com");
    expect(normalizeBaseUrl("https://www.okx.com/", "okx")).toBe(
      "https://www.okx.com",
    );
  });

  it("rejects http, paths, query strings and credentials", () => {
    expect(normalizeBaseUrl("http://www.okx.com", "okx")).toBeNull();
    expect(normalizeBaseUrl("https://www.okx.com/zh", "okx")).toBeNull();
    expect(normalizeBaseUrl("https://www.okx.com?a=1", "okx")).toBeNull();
    expect(normalizeBaseUrl("https://user:pw@www.okx.com", "okx")).toBeNull();
    expect(normalizeBaseUrl(42, "okx")).toBeNull();
  });
});

describe("parseSecret", () => {
  it("requires key and secret for both venues", () => {
    expect(
      parseSecret("binance", JSON.stringify({ key: "k", secret: "s" })),
    ).toEqual({ key: "k", secret: "s" });
    expect(parseSecret("binance", JSON.stringify({ key: "k" }))).toBeNull();
    expect(parseSecret("binance", "{oops")).toBeNull();
    expect(parseSecret("binance", undefined)).toBeNull();
  });

  it("requires a passphrase for OKX only", () => {
    expect(
      parseSecret("okx", JSON.stringify({ key: "k", secret: "s" })),
    ).toBeNull();
    expect(parseSecret("okx", okxSecret)).toEqual({
      key: "k",
      secret: "s",
      passphrase: "p",
    });
  });
});

describe("configuredAccounts", () => {
  it("returns nothing when the section is absent or unreadable", () => {
    expect(configuredAccounts(envWith(undefined))).toEqual([]);
    expect(
      configuredAccounts({ DESKWAND_CONFIG: "{oops" } as unknown as Env),
    ).toEqual([]);
    expect(configuredAccounts(envWith({ accounts: "nope" }))).toEqual([]);
  });

  it("keeps both venues when both are configured", () => {
    const accounts = configuredAccounts(
      envWith(
        {
          accounts: [
            { id: "okx-main", venue: "okx" },
            { id: "bn-main", venue: "binance", label: "Binance 主号" },
          ],
        },
        {
          EXCHANGE_SECRET_OKX_MAIN: okxSecret,
          EXCHANGE_SECRET_BN_MAIN: '{"key":"k","secret":"s"}',
        },
      ),
    );
    expect(
      accounts.map((account) => [account.id, account.venue, account.label]),
    ).toEqual([
      ["okx-main", "okx", "okx-main"],
      ["bn-main", "binance", "Binance 主号"],
    ]);
    expect(accounts[0]!.baseUrl).toBe("https://www.okx.com");
    expect(accounts[1]!.baseUrl).toBe("https://api.binance.com");
  });

  it("drops only the bad account and warns for the missing secret", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const accounts = configuredAccounts(
      envWith(
        {
          accounts: [
            { id: "bad-venue", venue: "binance-us" },
            { id: "no-secret", venue: "binance" },
            { id: "ok", venue: "binance" },
          ],
        },
        { EXCHANGE_SECRET_OK: '{"key":"k","secret":"s"}' },
      ),
    );
    expect(accounts.map((account) => account.id)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("no-secret");
    warn.mockRestore();
  });

  it("rejects bad ids and duplicate ids", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const accounts = configuredAccounts(
      envWith(
        {
          accounts: [
            { id: "Bad_ID", venue: "binance" },
            { id: "dup", venue: "binance" },
            { id: "dup", venue: "binance" },
          ],
        },
        { EXCHANGE_SECRET_DUP: '{"key":"k","secret":"s"}' },
      ),
    );
    expect(accounts.map((account) => account.id)).toEqual(["dup"]);
    warn.mockRestore();
  });

  it("matches the upper-cased secret name for a lower-case id", () => {
    const accounts = configuredAccounts(
      envWith({ accounts: [{ id: "main", venue: "binance" }] }, {
        EXCHANGE_SECRET_MAIN: '{"key":"k","secret":"s"}',
      }),
    );
    expect(accounts).toHaveLength(1);
  });
});
