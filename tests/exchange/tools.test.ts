import { describe, expect, it } from "vitest";
import { exchangeAssetsTool } from "../../src/tools/exchange";
import { createSnapshotCache } from "../../src/exchange/cache";
import {
  ExchangeError,
  type ExchangeAccount,
  type VenueAdapter,
  type VenueSnapshot,
} from "../../src/exchange/types";

const okx: ExchangeAccount = {
  id: "okx-main",
  venue: "okx",
  label: "OKX 主号",
  baseUrl: "https://www.okx.com",
  secret: { key: "k", secret: "s", passphrase: "p" },
};
const bn: ExchangeAccount = {
  id: "bn-main",
  venue: "binance",
  label: "Binance 主号",
  baseUrl: "https://api.binance.com",
  secret: { key: "k", secret: "s" },
};

function snapshot(account: ExchangeAccount, total: number): VenueSnapshot {
  return {
    venue: account.venue,
    account: account.id,
    fetchedAt: 0,
    total,
    buckets: [
      {
        bucket: "spot",
        value: total,
        balances: [
          { ccy: "USDT", amount: total, value: total, bucket: "spot" },
          { ccy: "DUST", amount: 0.00000001, value: 0.5, bucket: "spot" },
        ],
      },
    ],
    positions: [],
    degraded: [],
  };
}

function adapters(
  overrides: { okx?: Partial<VenueAdapter>; binance?: Partial<VenueAdapter> } = {},
): Record<"okx" | "binance", VenueAdapter> {
  const base = (id: "okx" | "binance"): VenueAdapter => ({
    id,
    label: id,
    supports: ["spot", "funding", "margin", "futures", "earn"],
    async fetch(account) {
      return snapshot(account, id === "okx" ? 1000 : 2000);
    },
  });
  return {
    okx: { ...base("okx"), ...overrides.okx },
    binance: { ...base("binance"), ...overrides.binance },
  };
}

function deps(overrides: Parameters<typeof adapters>[0] = {}) {
  return {
    locale: () => "zh" as const,
    adapters: adapters(overrides),
    cache: createSnapshotCache(() => 0),
  };
}

async function run(
  accounts: ExchangeAccount[],
  args: Record<string, unknown>,
  toolDeps = deps(),
) {
  const tool = exchangeAssetsTool(accounts, toolDeps);
  const result = await tool.execute(args as never, {} as never, {
    abortSignal: undefined,
  } as never);
  const text = (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
  return { text, result };
}

describe("exchange_assets", () => {
  it("reports every account with a cross-venue total", async () => {
    const { text } = await run([okx, bn], {});
    expect(text).toContain("合计 ≈ 3,000 USDT");
    expect(text).toContain("OKX 主号");
    expect(text).toContain("Binance 主号");
  });

  it("only queries the requested account", async () => {
    const { text } = await run([okx, bn], { account: "bn-main" });
    expect(text).toContain("Binance 主号");
    expect(text).not.toContain("OKX 主号");
    expect(text).not.toContain("合计 ≈");
  });

  it("fails only the broken account and keeps the healthy one", async () => {
    const toolDeps = deps({
      binance: {
        async fetch() {
          throw new ExchangeError("region", 451);
        },
      },
    });
    const { text, result } = await run([okx, bn], {}, toolDeps);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("OKX 主号");
    expect(text).toContain("跳过（Binance 判定当前出口 IP 在受限地区");
  });

  it("returns an error only when every requested account fails", async () => {
    const toolDeps = deps({
      okx: {
        async fetch() {
          throw new ExchangeError("timeout");
        },
      },
      binance: {
        async fetch() {
          throw new ExchangeError("region", 451);
        },
      },
    });
    const { result, text } = await run([okx, bn], {}, toolDeps);
    expect(result.isError).toBe(true);
    expect(text).toContain("共 2 个账号全部失败");
  });

  it("folds dust below minValue into one line", async () => {
    const { text } = await run([okx], { minValue: 5 });
    expect(text).toContain("另有 1 个小于 5 USDT 的币种");
    expect(text).not.toContain("DUST");
  });

  it("keeps a tiny amount visible instead of rounding it to zero", async () => {
    const { text } = await run([okx], { minValue: 0 });
    expect(text).toContain("DUST 0.00000001");
  });

  it("serves a cached snapshot with its age and skips the fetch", async () => {
    let calls = 0;
    const toolDeps = deps({
      okx: {
        async fetch(account) {
          calls += 1;
          return snapshot(account, 1000);
        },
      },
    });
    await run([okx], {}, toolDeps);
    const second = await run([okx], {}, toolDeps);
    expect(calls).toBe(1);
    expect(second.text).toContain("数据取自 0 秒前");
  });

  it("refetches when include changes", async () => {
    let calls = 0;
    const toolDeps = deps({
      okx: {
        async fetch(account) {
          calls += 1;
          return snapshot(account, 1000);
        },
      },
    });
    await run([okx], { include: ["spot"] }, toolDeps);
    await run([okx], { include: ["funding"] }, toolDeps);
    expect(calls).toBe(2);
  });

  it("caps one call at 8 accounts and lists the rest", async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      ...bn,
      id: `bn-${index}`,
      label: `bn-${index}`,
    }));
    const { text } = await run(many, {});
    expect(text).toContain("还有 1 个账号未查");
    expect(text).toContain("bn-8");
  });

  it("maps an OKX margin request onto the trading account and says so", async () => {
    let reached: readonly string[] = [];
    const toolDeps = deps({
      okx: {
        async fetch(account, opts) {
          reached = opts.include;
          return snapshot(account, 1000);
        },
      },
    });
    const { text } = await run([okx], { include: ["margin"] }, toolDeps);
    expect(reached).toEqual(["spot"]);
    expect(text).toContain("OKX 的杠杆并入交易账户");
    expect(text).not.toContain("没有任何非零余额");
  });

  it("does not repeat the margin note when margin was not asked for", async () => {
    const { text } = await run([okx], { include: ["spot"] });
    expect(text).not.toContain("OKX 的杠杆并入交易账户");
  });

  it("counts only the balances it actually hid when truncating", async () => {
    const crowded: VenueSnapshot = {
      ...snapshot(okx, 100),
      buckets: [
        {
          bucket: "spot",
          value: 100,
          balances: [
            { ccy: "USDT", amount: 100, value: 100, bucket: "spot" },
            ...Array.from({ length: 30 }, (_, index) => ({
              ccy: `C${index}`,
              amount: 1,
              value: 10,
              bucket: "spot" as const,
            })),
            ...Array.from({ length: 5 }, (_, index) => ({
              ccy: `D${index}`,
              amount: 1,
              value: 0.1,
              bucket: "spot" as const,
            })),
          ],
        },
      ],
    };
    const toolDeps = deps({
      okx: {
        async fetch() {
          return crowded;
        },
      },
    });
    const { text } = await run([okx], { limit: 25, minValue: 1 }, toolDeps);
    expect(text).toContain("还有 6 个币种未显示");
    expect(text).toContain("另有 5 个小于 1 USDT 的币种");
  });

  it("drops whole accounts when the output would overflow", async () => {
    const buckets = ["spot", "funding", "margin", "futures", "earn"] as const;
    const heavy = (account: ExchangeAccount): VenueSnapshot => ({
      ...snapshot(account, 100),
      buckets: buckets.map((bucket) => ({
        bucket,
        value: 100,
        balances: Array.from({ length: 100 }, (_, index) => ({
          ccy: `${bucket.toUpperCase()}${index}`,
          amount: 1,
          value: 10,
          bucket,
        })),
      })),
    });
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...bn,
      id: `bn-${index}`,
      label: `bn-${index}`,
    }));
    const toolDeps = deps({
      binance: {
        async fetch(account) {
          return heavy(account);
        },
      },
    });
    const { text } = await run(many, { limit: 100 }, toolDeps);
    expect(text).toContain("个账号未显示");
    expect(text).not.toContain("bn-7");
  });

  it("names an unknown account", async () => {
    const { result, text } = await run([okx], { account: "nope" });
    expect(result.isError).toBe(true);
    expect(text).toContain("没有这个交易所账号：nope");
  });
});
