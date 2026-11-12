import type { ToolRegistration } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../src/i18n";
import {
  createEarnerTools,
  createWalletResumeTool,
  createWalletTools,
  type WalletEarnerPort,
} from "../../src/wallet/tools";
import type {
  HistoryRow,
  SwapResult,
  WalletStatus,
} from "../../src/wallet/wallet-do";

const OWNER = "0x1111111111111111111111111111111111111111";

function status(overrides: Partial<WalletStatus> = {}): WalletStatus {
  return {
    address: "0x2222222222222222222222222222222222222222",
    holdings: {
      ethWei: 0n,
      tokens: {
        USDC: 100_000_000n,
        WETH: 1_500_000_000_000_000_000n,
        cbBTC: 123_000_000n,
      },
      valueUsd: 123.45,
    },
    breaker: { tripped: false, lossUsd: 0 },
    pendingRemittance: { id: "rem-9", usdc: 20, at: 1_700_000_000_000 },
    ...overrides,
  };
}

async function run(
  tools: ReturnType<typeof createWalletTools>,
  args: Record<string, unknown> = {},
) {
  return runNamed(tools, "wallet_status", args);
}

async function runNamed(
  tools: ToolRegistration[],
  name: string,
  args: Record<string, unknown> = {},
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(args as never, {} as never, {} as never);
}

function swapOk(): SwapResult {
  return {
    ok: true,
    id: "trade-1",
    amountOut: "5000000000000000",
    valueBefore: 100,
    valueAfter: 100.5,
    txHash: `0x${"ab".repeat(32)}`,
  };
}

/** A minimal earner wallet with empty reads. */
function earnerPort(patch: Partial<WalletEarnerPort> = {}): WalletEarnerPort {
  return {
    status: vi.fn(async () => status()),
    prices: vi.fn(async () => []),
    swap: vi.fn(async () => swapOk()),
    history: vi.fn(async () => [] as HistoryRow[]),
    ...patch,
  };
}

function text(outcome: {
  output?: { type: string; text?: string }[];
}): string {
  return (outcome.output?.[0] as { text: string }).text;
}

describe("wallet_status", () => {
  it("shows the address, every holding at its own decimals and the value", async () => {
    const result = await run(
      createWalletTools({ status: vi.fn(async () => status()), locale: "zh" }),
    );
    const resultText = text(result);

    expect(resultText).toContain("0x2222222222222222222222222222222222222222");
    expect(resultText).toContain("USDC 100");
    expect(resultText).toContain("WETH 1.5");
    expect(resultText).toContain("cbBTC 1.23");
    expect(resultText).toContain("$123.45");
    expect(resultText).not.toContain(OWNER);
  });

  it("shows the pending remittance id so life_credit can settle it", async () => {
    const result = await run(
      createWalletTools({ status: vi.fn(async () => status()), locale: "zh" }),
    );

    expect(text(result)).toContain("rem-9");
    expect(text(result)).toContain("$20.00");
  });

  it("shows the breaker state and the window's realized loss", async () => {
    const result = await run(
      createWalletTools({
        status: vi.fn(async () =>
          status({ breaker: { tripped: true, lossUsd: 12.5 } }),
        ),
        locale: "zh",
      }),
    );

    expect(text(result)).toContain(
      t("zh", "wallet.status.breaker", { loss: "$12.50" }),
    );
  });

  it("says there is no pending remittance", async () => {
    const result = await run(
      createWalletTools({
        status: vi.fn(async () => status({ pendingRemittance: null })),
        locale: "en",
      }),
    );

    expect(text(result)).toContain("Pending remittance: none");
  });

  it("reports a failed read instead of rejecting", async () => {
    const result = await run(
      createWalletTools({
        status: vi.fn(async () => {
          throw new Error("rpc https://rpc.example/SECRET_KEY failed");
        }),
        locale: "zh",
      }),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("钱包：暂不可用");
    expect(text(result)).not.toContain("SECRET_KEY");
  });
});

describe("wallet_balances", () => {
  it("reuses the status lines and does not repeat the breaker line", async () => {
    const tools = createEarnerTools({
      wallet: () => ({ ...earnerPort(), status: vi.fn(async () => status()) }),
      locale: "zh",
    });
    const result = await runNamed(tools, "wallet_balances");

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("钱包");
    expect(text(result)).toContain("USDC 100");
    expect(text(result).split("熔断：").length - 1).toBe(1);
  });
});

describe("market_prices", () => {
  it("says there are no price points yet", async () => {
    const tools = createEarnerTools({ wallet: () => earnerPort(), locale: "zh" });
    const result = await runNamed(tools, "market_prices");

    expect(text(result)).toContain("暂无价格");
  });

  it("summarizes the latest, high, low and change, then every fourth point", async () => {
    const at = (hour: number) => Date.UTC(2030, 0, 1, hour);
    const prices = [
      {
        token: "WETH" as const,
        points: [
          { at: at(0), usd: 2000 },
          { at: at(1), usd: 1900 },
          { at: at(2), usd: 1950 },
          { at: at(3), usd: 1980 },
          { at: at(4), usd: 2100 },
        ],
      },
    ];
    const tools = createEarnerTools({
      wallet: () => ({ ...earnerPort(), prices: vi.fn(async () => prices) }),
      locale: "zh",
    });
    const result = await runNamed(tools, "market_prices", { hours: 24 });
    const resultText = text(result);

    expect(resultText).toContain("WETH");
    expect(resultText).toContain("$2100.00");
    expect(resultText).toContain("$1900.00");
    expect(resultText).toContain("+5.00%");
    expect(resultText).toContain("01-01 00:00");
    expect(resultText).toContain("01-01 04:00");
  });

  it("truncates hours to 1-168", async () => {
    const prices = vi.fn(async () => []);
    const tools = createEarnerTools({
      wallet: () => ({ ...earnerPort(), prices }),
      locale: "zh",
    });

    await runNamed(tools, "market_prices", { hours: 500 });
    await runNamed(tools, "market_prices", { hours: 0 });
    await runNamed(tools, "market_prices");

    expect(prices.mock.calls).toEqual([[168], [1], [24]]);
  });
});

describe("wallet_swap", () => {
  it("parses the token pair and the amount before calling the wallet", async () => {
    const swap = vi.fn(async () => swapOk());
    const tools = createEarnerTools({
      wallet: () => ({ ...earnerPort(), swap }),
      locale: "zh",
    });

    const result = await runNamed(tools, "wallet_swap", {
      sell: "USDC",
      buy: "WETH",
      amount: "10",
    });

    expect(swap.mock.calls).toEqual([["USDC", "WETH", "10"]]);
    expect(text(result)).toContain("0.005 WETH");
    expect(text(result)).toContain("$100.00 → $100.50");
    expect(text(result)).toContain(
      "https://basescan.org/tx/0x" + "ab".repeat(32),
    );
  });

  it("reports a refusal as an error in the owner's language", async () => {
    const tools = createEarnerTools({
      wallet: () => ({
        ...earnerPort(),
        swap: vi.fn(async () => ({
          ok: false as const,
          refusal: "too_large" as const,
          reason: "wallet.refusal.too_large",
          inFlight: false,
        })),
      }),
      locale: "zh",
    });

    const result = await runNamed(tools, "wallet_swap", {
      sell: "USDC",
      buy: "WETH",
      amount: "10",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(t("zh", "wallet.refusal.too_large"));
  });

  it("treats an in-flight swap as an error so the model does not retry", async () => {
    const tools = createEarnerTools({
      wallet: () => ({
        ...earnerPort(),
        swap: vi.fn(async () => ({
          ok: false as const,
          reason: "wallet.swap.inFlight",
          inFlight: true,
        })),
      }),
      locale: "zh",
    });

    const result = await runNamed(tools, "wallet_swap", {
      sell: "USDC",
      buy: "WETH",
      amount: "10",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(t("zh", "wallet.swap.inFlight"));
  });

  it("is not replay-safe", () => {
    const tools = createEarnerTools({ wallet: () => earnerPort(), locale: "zh" });

    expect(tools.find((tool) => tool.name === "wallet_swap")?.replay).toBeUndefined();
    for (const name of ["wallet_balances", "market_prices", "wallet_history"]) {
      expect(tools.find((tool) => tool.name === name)?.replay).toBe("safe");
    }
  });

  it("never echoes the error message, only the fixed text", async () => {
    const tools = createEarnerTools({
      wallet: () => ({
        ...earnerPort(),
        swap: vi.fn(async () => {
          throw new Error("rpc https://rpc.example/SECRET_KEY failed");
        }),
      }),
      locale: "zh",
    });

    const result = await runNamed(tools, "wallet_swap", {
      sell: "USDC",
      buy: "WETH",
      amount: "10",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(t("zh", "wallet.swap.rpc"));
    expect(text(result)).not.toContain("SECRET_KEY");
  });
});

describe("wallet_history", () => {
  it("lists both ledgers newest first with human amounts and no raw data", async () => {
    const hash = `0x${"cd".repeat(32)}` as const;
    const history: HistoryRow[] = [
      {
        kind: "swap",
        id: "trade-1",
        at: Date.UTC(2030, 0, 1, 9),
        status: "confirmed",
        sell: "USDC",
        buy: "WETH",
        amount: "10000000",
        valueDeltaUsd: -2.5,
        txHash: hash,
      },
      {
        kind: "remit",
        id: "rem-1",
        at: Date.UTC(2030, 0, 1, 8),
        status: "confirmed",
        amount: "5000000",
        valueDeltaUsd: null,
        txHash: hash,
      },
    ];
    const tools = createEarnerTools({
      wallet: () => ({ ...earnerPort(), history: vi.fn(async () => history) }),
      locale: "zh",
    });
    const result = await runNamed(tools, "wallet_history");
    const resultText = text(result);

    expect(resultText.indexOf("trade-1")).toBeLessThan(
      resultText.indexOf("rem-1"),
    );
    expect(resultText).toContain("10 USDC");
    expect(resultText).toContain("5 USDC");
    expect(resultText).toContain("-$2.50");
    expect(resultText).toContain("https://basescan.org/tx/" + hash);
    expect(resultText).not.toContain(OWNER);
    expect(resultText).not.toContain("raw");
  });

  it("says there is no history yet", async () => {
    const tools = createEarnerTools({ wallet: () => earnerPort(), locale: "zh" });

    expect(text(await runNamed(tools, "wallet_history"))).toContain("暂无记录");
  });

  it("truncates limit to 1-50 and defaults to 10", async () => {
    const history = vi.fn(async () => [] as HistoryRow[]);
    const tools = createEarnerTools({
      wallet: () => ({ ...earnerPort(), history }),
      locale: "zh",
    });

    await runNamed(tools, "wallet_history", { limit: 500 });
    await runNamed(tools, "wallet_history", { limit: 0 });
    await runNamed(tools, "wallet_history");

    expect(history.mock.calls).toEqual([[50], [1], [10]]);
  });
});

describe("wallet_resume_trading", () => {
  it("calls resumeTrading and confirms it", async () => {
    const resume = vi.fn(async () => {});
    const tool = createWalletResumeTool({ resume, locale: "zh" });

    expect(tool.name).toBe("wallet_resume_trading");
    const result = await tool.execute({} as never, {} as never, {} as never);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(text(result)).toContain("恢复");
  });

  it("reports a failed resume without echoing the error", async () => {
    const tool = createWalletResumeTool({
      resume: vi.fn(async () => {
        throw new Error("rpc https://rpc.example/SECRET_KEY failed");
      }),
      locale: "zh",
    });

    const result = await tool.execute({} as never, {} as never, {} as never);

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(t("zh", "wallet.vitals.unavailable"));
    expect(text(result)).not.toContain("SECRET_KEY");
  });
});
