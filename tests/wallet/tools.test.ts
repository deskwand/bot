import { describe, expect, it, vi } from "vitest";
import { createWalletTools } from "../../src/wallet/tools";
import type { WalletStatus } from "../../src/wallet/wallet-do";

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
    pendingRemittance: { id: "rem-9", usdc: 20, at: 1_700_000_000_000 },
    ...overrides,
  };
}

async function run(
  tools: ReturnType<typeof createWalletTools>,
  args: Record<string, unknown> = {},
) {
  const tool = tools.find((candidate) => candidate.name === "wallet_status");
  if (!tool) throw new Error("missing tool wallet_status");
  return tool.execute(args as never, {} as never, {} as never);
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
