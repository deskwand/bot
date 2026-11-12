import { encodeFunctionData, type Address } from "viem";
import {
  erc20Abi,
  swapRouterAbi,
  type ChainConstants,
  type Token,
  type TxRequest,
} from "./chain.ts";

/** The only outbound transfer P1 builds: USDC to the owner. */
export function transferTx(
  c: ChainConstants,
  owner: Address,
  amount: bigint,
): TxRequest {
  const token = c.tokens.USDC;
  if (token === undefined) {
    throw new Error("USDC is not available on this network");
  }
  return {
    to: token.address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [owner, amount],
    }),
  };
}

/** Approves the router for exactly this swap's input amount. */
export function approveTx(
  c: ChainConstants,
  token: Token,
  amount: bigint,
): TxRequest {
  const entry = c.tokens[token];
  if (entry === undefined) {
    throw new Error(`${token} is not available on this network`);
  }
  return {
    to: entry.address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [c.router, amount],
    }),
  };
}

/** Builds the only swap the wallet may make: SwapRouter02, to itself. */
export function swapTx(
  c: ChainConstants,
  self: Address,
  sell: Token,
  buy: Token,
  amountIn: bigint,
  amountOutMinimum: bigint,
  fee: number,
): TxRequest {
  const tokenIn = c.tokens[sell];
  const tokenOut = c.tokens[buy];
  if (tokenIn === undefined || tokenOut === undefined) {
    throw new Error("token is not available on this network");
  }
  return {
    to: c.router,
    data: encodeFunctionData({
      abi: swapRouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          fee,
          recipient: self,
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  };
}

/** The last line of defence before signing: tokens and the router only. */
export function assertAllowedTarget(c: ChainConstants, tx: TxRequest): void {
  const target = tx.to.toLowerCase();
  if (c.router.toLowerCase() === target) return;
  for (const token of Object.values(c.tokens)) {
    if (token !== undefined && token.address.toLowerCase() === target) return;
  }
  throw new Error("transaction target is not a whitelisted token");
}
