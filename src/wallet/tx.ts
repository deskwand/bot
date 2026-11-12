import { encodeFunctionData, type Address } from "viem";
import { erc20Abi, type ChainConstants, type TxRequest } from "./chain.ts";

/** The only outbound transaction P1 builds: USDC to the owner. */
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

/** The last line of defence before signing: only whitelisted tokens may be called. */
export function assertAllowedTarget(c: ChainConstants, tx: TxRequest): void {
  const target = tx.to.toLowerCase();
  for (const token of Object.values(c.tokens)) {
    if (token !== undefined && token.address.toLowerCase() === target) return;
  }
  throw new Error("transaction target is not a whitelisted token");
}
