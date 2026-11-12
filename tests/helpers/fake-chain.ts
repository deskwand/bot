import {
  decodeFunctionData,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  CHAINS,
  erc20Abi,
  pairKey,
  swapRouterAbi,
  type ChainPort,
  type ChainConstants,
  type Receipt,
  type Signed,
  type Token,
  type TxRequest,
} from "../../src/wallet/chain";

/** A marker the fake puts in every error so leak tests can grep for it. */
export const PRIVATE_KEY_SENTINEL = "PRIVATE_KEY_SENTINEL";

export type BroadcastMode = "ok" | "throw-mined" | "throw-unmined";

export type SwapOutcome = "ok" | "reverted";

type Decoded =
  | {
      kind: "approve";
      token: Token;
      spender: Address;
      amount: bigint;
    }
  | {
      kind: "swap";
      sell: Token;
      buy: Token;
      amountIn: bigint;
      amountOut: bigint;
      amountOutMinimum: bigint;
      recipient: Address;
    }
  | { kind: "other" };

/**
 * The hand-written chain port used by the wallet tests. It records every call
 * in order and lets each test choose how signing, broadcasting and receipts
 * behave.
 */
export class FakeChain implements ChainPort {
  readonly address: Address = "0x2222222222222222222222222222222222222222";

  ethWei = 0n;

  balances: Record<Token, bigint> = { USDC: 0n, WETH: 0n, cbBTC: 0n };

  /** Quote results keyed by `pairKey`, in USDC base units. */
  quotes = new Map<string, bigint>();

  /**
   * When both sides of a pair have a price (USDC counts as one dollar),
   * `quote` derives its result from these instead of `quotes`.
   */
  usdPrice: Partial<Record<Token, number>> = {};

  /** Router allowances keyed by `${token}:${spender}`. */
  allowances = new Map<string, bigint>();

  quoteCalls: string[] = [];

  calls: string[] = [];

  sent: TxRequest[] = [];

  /** Every raw transaction handed to `broadcast`, including failed attempts. */
  broadcasts: Hex[] = [];

  /** The chain's latest mined nonce; a mined transaction advances it by one. */
  latestNonce = 0;

  mined = new Set<Hex>();

  /** Per-hash receipts. `null` means "not mined yet". */
  receipts = new Map<Hex, Receipt | null>();

  /** Applied to any mined hash without an explicit entry. */
  defaultReceipt: Receipt | null = { status: "success", gasWei: 0n };

  broadcastMode: BroadcastMode = "ok";

  /** Determines the receipt of a mined swap and whether it moves balances. */
  swapOutcome: SwapOutcome = "ok";

  /** Runs when a transaction is first mined, before its receipt is read. */
  onMined?: (tx: TxRequest) => void;

  signError: Error | null = null;

  tokenBalanceError: Error | null = null;

  private readonly rawHashes = new Map<Hex, Hex>();

  private readonly rawNonces = new Map<Hex, number>();

  private readonly rawTxs = new Map<Hex, TxRequest>();

  private readonly decoded = new Map<Hex, Decoded>();

  private readonly applied = new Set<Hex>();

  async ethBalance(): Promise<bigint> {
    this.calls.push("ethBalance");
    return this.ethWei;
  }

  async tokenBalance(token: Token): Promise<bigint> {
    this.calls.push(`tokenBalance:${token}`);
    if (this.tokenBalanceError !== null) throw this.tokenBalanceError;
    return this.balances[token];
  }

  async nonce(): Promise<number> {
    this.calls.push("nonce");
    return this.latestNonce;
  }

  async quote(
    sell: Token,
    buy: Token,
    amountIn: bigint,
  ): Promise<bigint> {
    const key = pairKey(sell, buy);
    this.calls.push(`quote:${key}`);
    this.quoteCalls.push(key);
    return this.priceQuote(sell, buy, amountIn) ?? this.quotes.get(key) ?? 0n;
  }

  async allowance(token: Token, spender: Address): Promise<bigint> {
    this.calls.push(`allowance:${token}`);
    return this.allowances.get(this.allowanceKey(token, spender)) ?? 0n;
  }

  async sign(tx: TxRequest): Promise<Signed> {
    this.calls.push("sign");
    if (this.signError !== null) throw this.signError;
    this.sent.push(tx);
    const index = this.sent.length;
    const nonce = this.latestNonce;
    const raw = toHex(`fake-raw-${index}`);
    const hash = keccak256(raw);
    this.rawHashes.set(raw, hash);
    this.rawNonces.set(raw, nonce);
    this.rawTxs.set(raw, tx);
    return { hash, raw, nonce };
  }

  async broadcast(raw: Hex): Promise<void> {
    this.broadcasts.push(raw);
    const hash = this.rawHashes.get(raw);
    if (hash === undefined) throw new Error("unknown raw transaction");
    if (this.broadcastMode === "throw-unmined") {
      this.calls.push(`broadcast-failed:${hash}`);
      throw new Error(PRIVATE_KEY_SENTINEL);
    }
    if (!this.mined.has(hash)) {
      this.mined.add(hash);
      const nonce = this.rawNonces.get(raw) ?? this.latestNonce;
      this.latestNonce = Math.max(this.latestNonce, nonce + 1);
      const tx = this.rawTxs.get(raw);
      if (tx !== undefined) {
        this.decoded.set(hash, this.decode(tx));
        this.onMined?.(tx);
      }
    }
    this.calls.push(`broadcast:${hash}`);
    if (this.broadcastMode === "throw-mined") {
      throw new Error(PRIVATE_KEY_SENTINEL);
    }
  }

  async receipt(hash: Hex, _timeoutMs: number): Promise<Receipt | null> {
    this.calls.push(`receipt:${hash}`);
    const result = this.receiptFor(hash);
    if (result !== null) this.apply(hash, result);
    return result;
  }

  private receiptFor(hash: Hex): Receipt | null {
    if (this.receipts.has(hash)) return this.receipts.get(hash) ?? null;
    if (!this.mined.has(hash)) return null;
    const decoded = this.decoded.get(hash);
    if (decoded?.kind === "swap") {
      if (this.swapOutcome === "reverted") {
        return { status: "reverted", gasWei: 0n };
      }
      const allowance =
        this.allowances.get(
          this.allowanceKey(decoded.sell, CHAINS.base.router),
        ) ?? 0n;
      if (
        allowance < decoded.amountIn ||
        decoded.amountOut < decoded.amountOutMinimum ||
        decoded.recipient.toLowerCase() !== this.address.toLowerCase()
      ) {
        return { status: "reverted", gasWei: 0n };
      }
    }
    return this.defaultReceipt;
  }

  /** Applies on-chain side effects once, and only for a successful receipt. */
  private apply(hash: Hex, receipt: Receipt): void {
    if (receipt.status !== "success" || this.applied.has(hash)) return;
    const decoded = this.decoded.get(hash);
    if (decoded === undefined) return;
    this.applied.add(hash);
    if (decoded.kind === "approve") {
      this.allowances.set(
        this.allowanceKey(decoded.token, decoded.spender),
        decoded.amount,
      );
    } else if (decoded.kind === "swap") {
      const key = this.allowanceKey(decoded.sell, CHAINS.base.router);
      const left = (this.allowances.get(key) ?? 0n) - decoded.amountIn;
      this.allowances.set(key, left > 0n ? left : 0n);
      this.balances[decoded.sell] -= decoded.amountIn;
      this.balances[decoded.buy] += decoded.amountOut;
    }
  }

  private decode(tx: TxRequest): Decoded {
    const constants = CHAINS.base;
    if (tx.to.toLowerCase() === constants.router.toLowerCase()) {
      try {
        const result = decodeFunctionData({ abi: swapRouterAbi, data: tx.data });
        if (result.functionName !== "exactInputSingle") return { kind: "other" };
        const params = (
          result.args as readonly [
            {
              tokenIn: Address;
              tokenOut: Address;
              recipient: Address;
              amountIn: bigint;
              amountOutMinimum: bigint;
            },
          ]
        )[0];
        const sell = this.tokenAt(constants, params.tokenIn);
        const buy = this.tokenAt(constants, params.tokenOut);
        if (sell === null || buy === null) return { kind: "other" };
        return {
          kind: "swap",
          sell,
          buy,
          amountIn: params.amountIn,
          amountOut:
            this.priceQuote(sell, buy, params.amountIn) ??
            this.quotes.get(pairKey(sell, buy)) ??
            0n,
          amountOutMinimum: params.amountOutMinimum,
          recipient: params.recipient,
        };
      } catch {
        return { kind: "other" };
      }
    }

    const token = this.tokenAt(constants, tx.to);
    if (token === null) return { kind: "other" };
    try {
      const result = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (result.functionName !== "approve") return { kind: "other" };
      const [spender, amount] = result.args as readonly [Address, bigint];
      return { kind: "approve", token, spender, amount };
    } catch {
      return { kind: "other" };
    }
  }

  private tokenAt(constants: ChainConstants, address: Address): Token | null {
    for (const [token, entry] of Object.entries(constants.tokens)) {
      if (entry !== undefined && entry.address.toLowerCase() === address.toLowerCase()) {
        return token as Token;
      }
    }
    return null;
  }

  private allowanceKey(token: Token, spender: Address): string {
    return `${token}:${spender.toLowerCase()}`;
  }

  /** Pro-rata quote from USD prices, or `null` when a side has no price. */
  private priceQuote(
    sell: Token,
    buy: Token,
    amountIn: bigint,
  ): bigint | null {
    const sellPrice = sell === "USDC" ? 1 : this.usdPrice[sell];
    const buyPrice = buy === "USDC" ? 1 : this.usdPrice[buy];
    if (sellPrice === undefined || buyPrice === undefined) return null;
    const sellDecimals = CHAINS.base.tokens[sell]?.decimals;
    const buyDecimals = CHAINS.base.tokens[buy]?.decimals;
    if (sellDecimals === undefined || buyDecimals === undefined) return null;
    const scale = 1_000_000n;
    const sellScaled = BigInt(Math.round(sellPrice * Number(scale)));
    const buyScaled = BigInt(Math.round(buyPrice * Number(scale)));
    if (buyScaled === 0n) return 0n;
    return (
      (amountIn * sellScaled * 10n ** BigInt(buyDecimals)) /
      (10n ** BigInt(sellDecimals) * buyScaled)
    );
  }
}
