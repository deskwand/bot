import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { CHAINS, erc20Abi } from "../../src/wallet/chain";
import { assertAllowedTarget, transferTx } from "../../src/wallet/tx";

const OWNER = "0x1234567890abcdef1234567890abcdef12345678" as const;

describe("transferTx", () => {
  it("builds a USDC transfer to the owner", () => {
    const tx = transferTx(CHAINS.base, OWNER, 10_000_000n);

    expect(tx.to).toBe(CHAINS.base.tokens.USDC?.address);

    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("transfer");
    // viem returns the checksummed form, so compare case-insensitively.
    expect(decoded.args?.[0]?.toLowerCase()).toBe(OWNER);
    expect(decoded.args?.[1]).toBe(10_000_000n);
  });
});

describe("assertAllowedTarget", () => {
  it("accepts the USDC contract in either case", () => {
    const usdc = CHAINS.base.tokens.USDC?.address;
    if (usdc === undefined) throw new Error("USDC missing");
    expect(() =>
      assertAllowedTarget(CHAINS.base, { to: usdc, data: "0x" }),
    ).not.toThrow();
    expect(() =>
      assertAllowedTarget(CHAINS.base, {
        to: usdc.toLowerCase() as `0x${string}`,
        data: "0x",
      }),
    ).not.toThrow();
  });

  it("rejects the router", () => {
    expect(() =>
      assertAllowedTarget(CHAINS.base, { to: CHAINS.base.router, data: "0x" }),
    ).toThrow();
  });

  it("rejects an arbitrary address", () => {
    expect(() =>
      assertAllowedTarget(CHAINS.base, { to: OWNER, data: "0x" }),
    ).toThrow();
  });
});
