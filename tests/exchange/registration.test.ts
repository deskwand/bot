import { describe, expect, it } from "vitest";
import {
  exchangeExtension,
  exchangeSectionText,
} from "../../src/exchange/install";

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

const deps = { locale: () => "zh" as const };

const both = {
  accounts: [
    { id: "okx-main", venue: "okx", label: "OKX 主号" },
    { id: "bn-main", venue: "binance", label: "Binance 主号" },
  ],
};
const secrets = {
  EXCHANGE_SECRET_OKX_MAIN: '{"key":"k","secret":"s","passphrase":"p"}',
  EXCHANGE_SECRET_BN_MAIN: '{"key":"k","secret":"s"}',
};

describe("exchangeExtension", () => {
  it("is not installed without accounts", () => {
    expect(exchangeExtension(envWith(undefined), deps)).toBeNull();
  });

  it("is not installed when no secret is set", () => {
    expect(exchangeExtension(envWith(both), deps)).toBeNull();
  });

  it("is not installed when the deployment document is unreadable", () => {
    expect(
      exchangeExtension({ DESKWAND_CONFIG: "{oops" } as unknown as Env, deps),
    ).toBeNull();
  });

  it("installs one tool and one prompt section", () => {
    const ext = exchangeExtension(envWith(both, secrets), deps);
    expect(ext?.name).toBe("exchange");
    expect(ext?.tools?.map((tool) => tool.name)).toEqual(["exchange_assets"]);
    expect(ext?.sections?.map((section) => section.key)).toEqual(["exchange"]);
    expect(ext?.tools?.[0]?.replay).toBe("safe");
  });
});

describe("exchangeSectionText", () => {
  it("lists both venues and the read-only rule", () => {
    const text = exchangeSectionText(
      [
        {
          id: "okx-main",
          venue: "okx",
          label: "OKX 主号",
          baseUrl: "https://www.okx.com",
          secret: { key: "k", secret: "s", passphrase: "p" },
        },
        {
          id: "bn-main",
          venue: "binance",
          label: "Binance 主号",
          baseUrl: "https://api.binance.com",
          secret: { key: "k", secret: "s" },
        },
      ],
      "zh",
    );
    expect(text).toContain("OKX 主号（okx-main）");
    expect(text).toContain("Binance 主号（bn-main）");
    expect(text).toContain("只能读");
  });

  it("mentions the desktop sync when a Binance account exists", () => {
    const text = exchangeSectionText(
      [
        {
          id: "bn-main",
          venue: "binance",
          label: "Binance 主号",
          baseUrl: "https://api.binance.com",
          secret: { key: "k", secret: "s" },
        },
      ],
      "zh",
    );
    expect(text).toContain("Binance 数据可能来自桌面端同步");
  });

  it("does not mention the desktop sync for OKX only", () => {
    const text = exchangeSectionText(
      [
        {
          id: "okx-main",
          venue: "okx",
          label: "OKX 主号",
          baseUrl: "https://www.okx.com",
          secret: { key: "k", secret: "s", passphrase: "p" },
        },
      ],
      "zh",
    );
    expect(text).not.toContain("桌面端同步");
  });
});
