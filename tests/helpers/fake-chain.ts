import { keccak256, toHex, type Address, type Hex } from "viem";
import {
  pairKey,
  type ChainPort,
  type Receipt,
  type Signed,
  type Token,
  type TxRequest,
} from "../../src/wallet/chain";

/** A marker the fake puts in every error so leak tests can grep for it. */
export const PRIVATE_KEY_SENTINEL = "PRIVATE_KEY_SENTINEL";

export type BroadcastMode = "ok" | "throw-mined" | "throw-unmined";

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

  signError: Error | null = null;

  tokenBalanceError: Error | null = null;

  private readonly rawHashes = new Map<Hex, Hex>();

  private readonly rawNonces = new Map<Hex, number>();

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
    _amountIn: bigint,
  ): Promise<bigint> {
    const key = pairKey(sell, buy);
    this.calls.push(`quote:${key}`);
    this.quoteCalls.push(key);
    return this.quotes.get(key) ?? 0n;
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
    }
    this.calls.push(`broadcast:${hash}`);
    if (this.broadcastMode === "throw-mined") {
      throw new Error(PRIVATE_KEY_SENTINEL);
    }
  }

  async receipt(hash: Hex, _timeoutMs: number): Promise<Receipt | null> {
    this.calls.push(`receipt:${hash}`);
    if (this.receipts.has(hash)) return this.receipts.get(hash) ?? null;
    return this.mined.has(hash) ? this.defaultReceipt : null;
  }
}
