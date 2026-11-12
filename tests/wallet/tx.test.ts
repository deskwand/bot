import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { CHAINS, erc20Abi, swapRouterAbi } from "../../src/wallet/chain";
import {
  approveTx,
  assertAllowedTarget,
  swapTx,
  transferTx,
} from "../../src/wallet/tx";

const OWNER = "0x1234567890abcdef1234567890abcdef12345678" as const;
const SELF = "0x2222222222222222222222222222222222222222" as const;

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

describe("approveTx", () => {
  it("approves the router for exactly the given amount", () => {
    const tx = approveTx(CHAINS.base, "USDC", 10_000_000n);

    expect(tx.to).toBe(CHAINS.base.tokens.USDC?.address);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("approve");
    const [spender, amount] = decoded.args as readonly [string, bigint];
    expect(spender.toLowerCase()).toBe(CHAINS.base.router.toLowerCase());
    expect(amount).toBe(10_000_000n);
  });
});

describe("swapTx", () => {
  it("calls exactInputSingle with the wallet as the recipient", () => {
    const tx = swapTx(
      CHAINS.base,
      SELF,
      "USDC",
      "WETH",
      10_000_000n,
      9_900_000_000_000_000n,
      3000,
    );

    expect(tx.to).toBe(CHAINS.base.router);
    const decoded = decodeFunctionData({ abi: swapRouterAbi, data: tx.data });
    expect(decoded.functionName).toBe("exactInputSingle");
    const params = (
      decoded.args as readonly [
        {
          tokenIn: string;
          tokenOut: string;
          fee: number;
          recipient: string;
          amountIn: bigint;
          amountOutMinimum: bigint;
          sqrtPriceLimitX96: bigint;
        },
      ]
    )[0];
    expect(params.tokenIn.toLowerCase()).toBe(
      CHAINS.base.tokens.USDC?.address.toLowerCase(),
    );
    expect(params.tokenOut.toLowerCase()).toBe(
      CHAINS.base.tokens.WETH?.address.toLowerCase(),
    );
    expect(params.fee).toBe(3000);
    expect(params.recipient.toLowerCase()).toBe(SELF);
    expect(params.amountIn).toBe(10_000_000n);
    expect(params.amountOutMinimum).toBe(9_900_000_000_000_000n);
    expect(params.sqrtPriceLimitX96).toBe(0n);
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

  it("accepts the router", () => {
    expect(() =>
      assertAllowedTarget(CHAINS.base, { to: CHAINS.base.router, data: "0x" }),
    ).not.toThrow();
  });

  it("rejects an arbitrary address", () => {
    expect(() =>
      assertAllowedTarget(CHAINS.base, { to: OWNER, data: "0x" }),
    ).toThrow();
  });
});
