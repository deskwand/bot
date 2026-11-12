import type { Address, Hex } from "viem";

export type Token = "USDC" | "WETH" | "cbBTC";
export type Network = "base" | "base-sepolia";

export type ChainConstants = {
  chainId: number;
  tokens: Partial<Record<Token, { address: Address; decimals: number }>>;
  quoter: Address;
  router: Address;
  feeTier: Partial<Record<string, number>>;
};

export type TxRequest = { to: Address; data: Hex };
export type Signed = { hash: Hex; raw: Hex; nonce: number };
export type Receipt = { status: "success" | "reverted"; gasWei: bigint };

/**
 * The narrow chain surface the wallet depends on. Production uses `ViemChain`;
 * tests use a hand-written fake, so no code path needs a forged transport.
 */
export interface ChainPort {
  readonly address: Address;
  ethBalance(): Promise<bigint>;
  tokenBalance(token: Token): Promise<bigint>;
  quote(sell: Token, buy: Token, amountIn: bigint): Promise<bigint>;
  /** Signs with the latest mined nonce from the chain and a fixed `value: 0n`. */
  sign(tx: TxRequest): Promise<Signed>;
  /** The latest mined nonce; anything above a signed nonce means it is spent. */
  nonce(): Promise<number>;
  broadcast(raw: Hex): Promise<void>;
  /** `null` means not mined yet (or the timeout elapsed, or it was replaced). */
  receipt(hash: Hex, timeoutMs: number): Promise<Receipt | null>;
}

/** A token-pair key that does not depend on the argument order. */
export function pairKey(a: Token, b: Token): string {
  return [a, b].sort().join("/");
}

export const CHAINS: Record<Network, ChainConstants> = {
  base: {
    chainId: 8453,
    tokens: {
      USDC: {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6,
      },
      WETH: {
        address: "0x4200000000000000000000000000000000000006",
        decimals: 18,
      },
      cbBTC: {
        address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
        decimals: 8,
      },
    },
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    feeTier: {
      [pairKey("USDC", "WETH")]: 3000,
      [pairKey("USDC", "cbBTC")]: 500,
      [pairKey("WETH", "cbBTC")]: 500,
    },
  },
  "base-sepolia": {
    chainId: 84532,
    tokens: {
      USDC: {
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        decimals: 6,
      },
      WETH: {
        address: "0x4200000000000000000000000000000000000006",
        decimals: 18,
      },
    },
    quoter: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
    router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    feeTier: {
      [pairKey("USDC", "WETH")]: 3000,
    },
  },
};

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const quoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;
