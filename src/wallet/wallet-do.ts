import { DurableObject } from "cloudflare:workers";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BackupRpc } from "../admin/backup-rpc";
import {
  createIndexes,
  type DbSchema,
  type DumpPage,
  type DumpRow,
  type TableSchema,
} from "../admin/sql-dump";
import { getClock } from "../butler/notifier";
import {
  CHAINS,
  pairKey,
  type ChainPort,
  type Receipt,
  type Signed,
  type Token,
  type TxRequest,
} from "./chain";
import { walletConfig } from "./config";
import {
  breakerTripped,
  checkRemit,
  checkSwap,
  lossWindowStart,
  MAX_PRICE_HOURS,
  minOut,
  MIN_REMIT_USD,
  MIN_VALUE_USD,
  parseTokenAmount,
  PRICE_KEEP_MS,
  PRICE_PROBE_USDC,
  RECEIPT_TIMEOUT_MS,
  RECONCILE_RECEIPT_MS,
  remitAmountUsd,
  UNMINED_AFTER_MS,
  type Holdings,
  type Refusal,
} from "./guard";
import {
  WalletStore,
  type JournalRow,
  type PriceSeries,
  type RemittanceRow,
} from "./store";
import { approveTx, assertAllowedTarget, swapTx, transferTx } from "./tx";
import { ViemChain } from "./viem-chain";

const HOUR_MS = 3_600_000;
/** How soon the reconcile alarm fires after a signed transaction stays open. */
const RECONCILE_ALARM_MS = 2 * 60_000;
/** How soon to try again while a signed transaction is still pending. */
const RECONCILE_RETRY_MS = 5 * 60_000;
const STUCK_NOTICE_PREFIX = "stuck_noticed:";
const RESUMED_AT_KEY = "resumed_at";
const SAMPLED_HOUR_KEY = "sampled_hour";
const FUNDED_KEY = "funded";
const DEPLETED_NOTICED_KEY = "depleted_noticed";
/** Admin-facing English; this is not spoken by the model. */
const RESTORE_IN_FLIGHT =
  "a remittance is still in flight; retry the restore in a few minutes";

export type WalletStatus = {
  address: Address;
  holdings: Holdings;
  breaker: { tripped: boolean; lossUsd: number };
  pendingRemittance: { id: string; usdc: number; at: number } | null;
};

export type RemitResult =
  | { ok: true; id: string; usdc: number; txHash: Hex }
  | {
      ok: false;
      id: string | null;
      reason: string;
      inFlight: boolean;
    };

export type SwapResult =
  | {
      ok: true;
      id: string;
      amountOut: string;
      valueBefore: number;
      valueAfter: number | null;
      txHash: Hex;
    }
  | {
      ok: false;
      refusal?: Refusal;
      reason: string;
      inFlight: boolean;
    };

export type HistoryRow = {
  kind: "swap" | "remit";
  id: string;
  at: number;
  status: string;
  sell?: Token;
  buy?: Token;
  amount: string;
  valueDeltaUsd: number | null;
  txHash: Hex | null;
};

/** A fixed-copy message the wallet asks the Butler to relay to the owner. */
export type WalletNotice =
  | {
      kind: "wallet.remit";
      id: string;
      usdc: number;
      shortUsd: number;
      txUrl: string;
      body: "";
    }
  | { kind: "wallet.remitFailed"; usdc: number; reason: string; body: "" }
  | { kind: "wallet.tradeStuck"; reason?: string; body: "" }
  | { kind: "wallet.depleted"; valueUsd: number; body: "" };

/** Just the Butler RPC a wallet notice needs. */
type RemittanceNotifier = {
  notifyRemittance(event: WalletNotice): Promise<void>;
};

/** Test-only replacement for the configured wallet and its owner. */
let chainOverride: { chain: ChainPort; owner: Address } | null = null;

/**
 * Replaces the chain and owner while a test runs. The override lives in the
 * module, so the Durable Object (in the same isolate) sees it too.
 */
export function setWalletChainOverride(
  o: { chain: ChainPort; owner: Address } | null,
): void {
  chainOverride = o;
}

/** A configured wallet is either the test override or valid secrets. */
export function walletConfigured(env: Env): boolean {
  return chainOverride !== null || walletConfig(env) !== null;
}

/** The public wallet address, derived from the key; never throws. */
export function walletAddress(env: Env): Address | null {
  if (chainOverride !== null) return chainOverride.chain.address;
  const config = walletConfig(env);
  if (config === null) return null;
  try {
    return privateKeyToAccount(config.privateKey).address;
  } catch {
    return null;
  }
}

/** The one global wallet. */
export function walletStub(env: Env): DurableObjectStub<WalletDO> {
  return env.WALLET.get(env.WALLET.idFromName("global"));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "Error";
}

function toUsd(usdc: string): number {
  return Number(BigInt(usdc)) / 1e6;
}

export function txUrl(hash: Hex): string {
  return "https://basescan.org/tx/" + hash;
}

/**
 * The global Base wallet: balances, valuation, remittances and the
 * reconciliation that keeps a half-finished transfer from being sent twice.
 */
export class WalletDO extends DurableObject<Env> {
  private readonly store: WalletStore;

  private readonly backup: BackupRpc;

  private queue: Promise<unknown> = Promise.resolve();

  private cachedValue: { hour: number; usd: number } | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new WalletStore(ctx.storage.sql);
    // The wallet has no maintenance lease of its own; the Butler holds it.
    this.backup = new BackupRpc(ctx, null);
  }

  async backupSchema(): Promise<DbSchema> {
    return this.backup.backupSchema();
  }

  async backupPage(
    table: TableSchema,
    cursor: string | null,
  ): Promise<DumpPage> {
    return this.backup.backupPage(table, cursor);
  }

  async restoreBegin(schema: DbSchema): Promise<void> {
    return this.enqueue(async () => {
      await this.reconcile();
      if (this.store.pendingAll().length > 0) {
        throw new Error(RESTORE_IN_FLIGHT);
      }
      await this.backup.restoreBegin(schema);
      this.cachedValue = undefined;
    });
  }

  async restorePage(table: TableSchema, rows: DumpRow[]): Promise<void> {
    await this.backup.restorePage(table, rows);
  }

  async restoreCommit(schema: DbSchema): Promise<void> {
    // The wallet arms its reconcile alarm from its own writes; a restore only
    // needs the indexes back.
    createIndexes(this.ctx.storage.sql, schema);
    this.cachedValue = undefined;
  }

  async restoreReset(): Promise<void> {
    return this.enqueue(async () => {
      await this.reconcile();
      if (this.store.pendingAll().length > 0) {
        throw new Error(RESTORE_IN_FLIGHT);
      }
      this.backup.restoreReset();
    });
  }

  async status(): Promise<WalletStatus> {
    const resolved = this.resolved();
    if (resolved === null) throw new Error("wallet is not configured");
    const holdings = await this.holdings(resolved.chain);
    const now = getClock().now();
    const lossUsd = await this.realizedLossUsd(now);
    // A confirmed trade without a recorded value could hide a loss.
    const incomplete = await this.hasIncompleteTrades(now);
    const pending = this.store.pendingRemittance(now);
    return {
      address: resolved.chain.address,
      holdings,
      breaker: {
        tripped: incomplete || breakerTripped(lossUsd, holdings.valueUsd),
        lossUsd,
      },
      pendingRemittance:
        pending === undefined
          ? null
          : { id: pending.id, usdc: toUsd(pending.usdc), at: pending.at },
    };
  }

  /** Hourly in-memory cache; every write clears it. */
  async valueUsd(): Promise<number> {
    const hour = Math.floor(getClock().now() / HOUR_MS);
    if (this.cachedValue?.hour === hour) return this.cachedValue.usd;
    const resolved = this.resolved();
    if (resolved === null) throw new Error("wallet is not configured");
    const holdings = await this.holdings(resolved.chain);
    this.cachedValue = { hour, usd: holdings.valueUsd };
    return holdings.valueUsd;
  }

  /** Hourly samples for WETH and cbBTC, oldest point first. */
  async prices(hours: number): Promise<PriceSeries[]> {
    const safe = Number.isFinite(hours) ? Math.trunc(hours) : 24;
    const bounded = Math.min(MAX_PRICE_HOURS, Math.max(1, safe));
    const nowHour = Math.floor(getClock().now() / HOUR_MS);
    return this.store.priceSeries(nowHour - bounded + 1);
  }

  /** The Worker cron calls this so a lost alarm is repaired within 15 minutes. */
  async ensureAlarm(): Promise<void> {
    if (this.resolved() === null) return;
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(this.nextHour());
  }

  async remit(amountUsd: number, reason: string): Promise<RemitResult> {
    return this.enqueue(async () => {
      this.cachedValue = undefined;
      const busy = await this.reconcile();
      if (busy !== null) {
        await this.armReconcile();
        return {
          ok: false,
          id: busy.id,
          reason: "wallet.error.busy",
          inFlight: true,
        };
      }
      return this.#remitLocked(amountUsd, reason);
    });
  }

  /**
   * Exchanges one whitelisted token for another through SwapRouter02. The
   * approve is not journaled: it only sets an allowance, so repeating it can
   * never move assets. Everything else follows the remittance flow.
   */
  async swap(sell: Token, buy: Token, amount: string): Promise<SwapResult> {
    return this.enqueue(async () => {
      this.cachedValue = undefined;
      const resolved = this.resolved();
      if (resolved === null) {
        return {
          ok: false,
          reason: "wallet.error.unconfigured",
          inFlight: false,
        };
      }

      const busy = await this.reconcile();
      if (busy !== null) {
        await this.armReconcile();
        return { ok: false, reason: "wallet.swap.busy", inFlight: true };
      }

      const constants = CHAINS.base;
      const sellEntry = constants.tokens[sell];
      const buyEntry = constants.tokens[buy];
      const whitelisted = sellEntry !== undefined && buyEntry !== undefined;
      if (!whitelisted) {
        return {
          ok: false,
          refusal: "not_whitelisted",
          reason: "wallet.refusal.not_whitelisted",
          inFlight: false,
        };
      }
      const amountIn = parseTokenAmount(amount, sellEntry.decimals);
      if (amountIn === null || amountIn <= 0n) {
        return {
          ok: false,
          refusal: "bad_amount",
          reason: "wallet.refusal.bad_amount",
          inFlight: false,
        };
      }

      const now = getClock().now();
      // A confirmed trade whose value was never recorded could hide a loss;
      // until reconciliation fills it in, trading stays conservative.
      if (await this.hasIncompleteTrades(now)) {
        return {
          ok: false,
          refusal: "breaker",
          reason: "wallet.refusal.breaker",
          inFlight: false,
        };
      }

      let holdings: Holdings;
      let amountInUsd: number;
      try {
        holdings = await this.holdings(resolved.chain);
        amountInUsd =
          sell === "USDC"
            ? Number(amountIn) / 1e6
            : Number(await resolved.chain.quote(sell, "USDC", amountIn)) /
              1e6;
      } catch (error) {
        console.warn("wallet: swap valuation failed", errorName(error));
        return { ok: false, reason: "wallet.swap.rpc", inFlight: false };
      }

      const feeTier = constants.feeTier[pairKey(sell, buy)];
      const refusal = checkSwap({
        sell,
        buy,
        amountIn,
        amountInUsd,
        holdings,
        realizedLossUsd: await this.realizedLossUsd(now),
        feeTier,
        whitelisted,
      });
      if (refusal !== null) {
        return {
          ok: false,
          refusal,
          reason: `wallet.refusal.${refusal}`,
          inFlight: false,
        };
      }

      let allowance: bigint;
      try {
        allowance = await resolved.chain.allowance(sell, constants.router);
      } catch (error) {
        console.warn("wallet: allowance read failed", errorName(error));
        return { ok: false, reason: "wallet.swap.rpc", inFlight: false };
      }

      if (allowance < amountIn) {
        let approvedNonce: number;
        try {
          const approve = approveTx(constants, sell, amountIn);
          assertAllowedTarget(constants, approve);
          const signed = await resolved.chain.sign(approve);
          await resolved.chain.broadcast(signed.raw);
          const receipt = await resolved.chain.receipt(
            signed.hash,
            RECEIPT_TIMEOUT_MS,
          );
          if (receipt?.status !== "success") {
            return {
              ok: false,
              reason: "wallet.swap.approve",
              inFlight: false,
            };
          }
          approvedNonce = signed.nonce;
        } catch (error) {
          console.warn("wallet: approve failed", errorName(error));
          return { ok: false, reason: "wallet.swap.approve", inFlight: false };
        }

        // A node that has not seen the approve yet would hand the swap the
        // same nonce, and only one of the two could ever be mined.
        let tip: number;
        try {
          tip = await resolved.chain.nonce();
        } catch (error) {
          console.warn("wallet: nonce read failed", errorName(error));
          return { ok: false, reason: "wallet.swap.rpc", inFlight: false };
        }
        if (tip <= approvedNonce) {
          return {
            ok: false,
            reason: "wallet.swap.approve",
            inFlight: false,
          };
        }
      }

      let quoted: bigint;
      try {
        quoted = await resolved.chain.quote(sell, buy, amountIn);
      } catch (error) {
        console.warn("wallet: swap quote failed", errorName(error));
        return { ok: false, reason: "wallet.swap.rpc", inFlight: false };
      }
      const amountOutMinimum = minOut(quoted);

      const id = crypto.randomUUID();
      const valueBefore = holdings.valueUsd;
      this.store.insertTrade(
        id,
        now,
        sell,
        buy,
        amountIn,
        amountOutMinimum,
        valueBefore,
      );

      let tx: TxRequest;
      try {
        tx = swapTx(
          constants,
          resolved.chain.address,
          sell,
          buy,
          amountIn,
          amountOutMinimum,
          feeTier as number,
        );
        assertAllowedTarget(constants, tx);
      } catch (error) {
        this.store.markFailed("trades", id, errorName(error));
        this.cachedValue = undefined;
        console.warn("wallet: swap build failed", errorName(error));
        return { ok: false, reason: "wallet.swap.rpc", inFlight: false };
      }

      let signed: Signed;
      try {
        signed = await resolved.chain.sign(tx);
      } catch (error) {
        this.store.markFailed("trades", id, errorName(error));
        this.cachedValue = undefined;
        console.warn("wallet: swap signing failed", errorName(error));
        return { ok: false, reason: "wallet.swap.rpc", inFlight: false };
      }
      this.store.setTradeHash(id, signed.hash, signed.nonce, signed.raw);

      try {
        await resolved.chain.broadcast(signed.raw);
      } catch (error) {
        this.cachedValue = undefined;
        console.warn("wallet: swap broadcast failed", errorName(error));
        await this.armReconcile();
        return { ok: false, reason: "wallet.swap.inFlight", inFlight: true };
      }

      let receipt: Receipt | null;
      try {
        receipt = await resolved.chain.receipt(
          signed.hash,
          RECEIPT_TIMEOUT_MS,
        );
      } catch (error) {
        this.cachedValue = undefined;
        console.warn("wallet: swap receipt read failed", errorName(error));
        await this.armReconcile();
        return { ok: false, reason: "wallet.swap.inFlight", inFlight: true };
      }
      this.cachedValue = undefined;

      if (receipt === null) {
        await this.armReconcile();
        return { ok: false, reason: "wallet.swap.inFlight", inFlight: true };
      }
      if (receipt.status === "reverted") {
        this.store.markFailed("trades", id, "wallet.error.reverted");
        return {
          ok: false,
          reason: "wallet.error.reverted",
          inFlight: false,
        };
      }

      this.store.markConfirmed("trades", id);
      let valueAfter: number | null = null;
      try {
        valueAfter = await this.valueUsd();
        this.store.setTradeValueAfter(id, valueAfter);
      } catch (error) {
        console.warn("wallet: swap value read failed", errorName(error));
      }
      this.cachedValue = undefined;

      return {
        ok: true,
        id,
        amountOut: quoted.toString(),
        valueBefore,
        valueAfter,
        txHash: signed.hash,
      };
    });
  }

  async resumeTrading(): Promise<void> {
    this.cachedValue = undefined;
    await this.ctx.storage.kv.put(RESUMED_AT_KEY, getClock().now());
  }

  /** Realized losses inside the breaker window, in US dollars. */
  async realizedLossUsd(now: number): Promise<number> {
    const since = lossWindowStart(now, await this.resumedAt());
    let loss = 0;
    for (const row of this.store.confirmedTrades(since)) {
      if (row.value_after === null) continue;
      loss += Math.max(0, row.value_before - row.value_after);
    }
    return loss;
  }

  async history(limit: number): Promise<HistoryRow[]> {
    const safe = Number.isFinite(limit) ? Math.trunc(limit) : 50;
    const bounded = Math.min(50, Math.max(1, safe));
    const remits: HistoryRow[] = this.store
      .recentRemittances(bounded)
      .map((row) => ({
        kind: "remit",
        id: row.id,
        at: row.at,
        status: row.status,
        amount: row.usdc,
        valueDeltaUsd: null,
        txHash: row.tx_hash,
      }));
    const trades: HistoryRow[] = this.store
      .recentTrades(bounded)
      .map((row) => ({
        kind: "swap",
        id: row.id,
        at: row.at,
        status: row.status,
        sell: row.sell as Token,
        buy: row.buy as Token,
        amount: row.amount_in,
        valueDeltaUsd:
          row.value_after === null
            ? null
            : row.value_after - row.value_before,
        txHash: row.tx_hash,
      }));
    return [...remits, ...trades]
      .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
      .slice(0, bounded);
  }

  /**
   * Remits 21 days of the current daily spend when the tier worsens, capped
   * by the USDC balance. Everything runs inside one queue task so concurrent
   * tier changes cannot send twice.
   */
  async autoRemit(v: {
    dailySpendUsd: number;
    balanceUsd: number;
    metabolismStarted: boolean;
  }): Promise<RemitResult | null> {
    return this.enqueue(async () => {
      this.cachedValue = undefined;
      if (!v.metabolismStarted || v.dailySpendUsd <= 0) return null;

      const resolved = this.resolved();
      if (resolved === null) return null;

      const busy = await this.reconcile();
      if (busy !== null) {
        await this.armReconcile();
        return null;
      }
      if (this.store.pendingRemittance(getClock().now()) !== undefined) {
        return null;
      }

      const need = remitAmountUsd(v.dailySpendUsd, v.balanceUsd);
      let balance: bigint;
      try {
        balance = await resolved.chain.tokenBalance("USDC");
      } catch (error) {
        console.warn("wallet: balance read failed", errorName(error));
        await this.notifyOwner({
          kind: "wallet.remitFailed",
          usdc: need,
          reason: "wallet.error.rpc",
          body: "",
        });
        return null;
      }

      const amount = Math.min(need, Number(balance) / 1e6);
      if (amount < MIN_REMIT_USD) return null;

      const result = await this.#remitLocked(amount, "auto");
      if (result.ok) {
        await this.notifyOwner({
          kind: "wallet.remit",
          id: result.id,
          usdc: result.usdc,
          shortUsd: Math.max(0, need - result.usdc),
          txUrl: txUrl(result.txHash),
          body: "",
        });
      } else if (!result.inFlight) {
        await this.notifyOwner({
          kind: "wallet.remitFailed",
          usdc: amount,
          reason: result.reason,
          body: "",
        });
      }
      return result;
    });
  }

  async settleRemittance(
    id: string,
  ): Promise<"settled" | "unknown" | "already"> {
    return this.enqueue(async () => {
      this.cachedValue = undefined;
      await this.reconcile();
      const row = this.store.get(id);
      if (row === undefined || row.status !== "confirmed") return "unknown";
      if (row.settled_at !== null) return "already";
      this.store.markSettled(id, getClock().now());
      return "settled";
    });
  }

  /**
   * Runs inside the write queue. The order is deliberate: journal the intent,
   * sign, persist the hash, then broadcast. Any crash in between leaves a row
   * the next reconciliation can resolve.
   */
  async #remitLocked(amountUsd: number, reason: string): Promise<RemitResult> {
    const resolved = this.resolved();
    if (resolved === null) {
      return {
        ok: false,
        id: null,
        reason: "wallet.error.unconfigured",
        inFlight: false,
      };
    }
    if (!Number.isFinite(amountUsd)) {
      return {
        ok: false,
        id: null,
        reason: "wallet.error.bad_amount",
        inFlight: false,
      };
    }

    const usdc = BigInt(Math.round(amountUsd * 1e6));
    let balance: bigint;
    try {
      balance = await resolved.chain.tokenBalance("USDC");
    } catch (error) {
      console.warn("wallet: balance read failed", errorName(error));
      return {
        ok: false,
        id: null,
        reason: "wallet.error.rpc",
        inFlight: false,
      };
    }
    const check = checkRemit(usdc, balance);
    if (check !== null) {
      return {
        ok: false,
        id: null,
        reason: `wallet.error.${check}`,
        inFlight: false,
      };
    }

    const id = crypto.randomUUID();
    this.store.insertPending(id, getClock().now(), usdc, reason);

    let tx: TxRequest;
    try {
      tx = transferTx(CHAINS.base, resolved.owner, usdc);
      assertAllowedTarget(CHAINS.base, tx);
    } catch (error) {
      this.store.markFailed("remittances", id, errorName(error));
      this.cachedValue = undefined;
      console.warn("wallet: transfer build failed", errorName(error));
      return { ok: false, id, reason: "wallet.error.rpc", inFlight: false };
    }

    let signed: Signed;
    try {
      signed = await resolved.chain.sign(tx);
    } catch (error) {
      this.store.markFailed("remittances", id, errorName(error));
      this.cachedValue = undefined;
      console.warn("wallet: signing failed", errorName(error));
      return { ok: false, id, reason: "wallet.error.rpc", inFlight: false };
    }
    this.store.setHash(id, signed.hash, signed.nonce, signed.raw);

    try {
      await resolved.chain.broadcast(signed.raw);
    } catch (error) {
      // The transaction may well be on chain now, so keep the hash and stay
      // pending. Reconciliation will decide.
      this.cachedValue = undefined;
      console.warn("wallet: broadcast failed", errorName(error));
      await this.armReconcile();
      return { ok: false, id, reason: "wallet.error.rpc", inFlight: true };
    }

    let receipt: Receipt | null;
    try {
      receipt = await resolved.chain.receipt(
        signed.hash,
        RECEIPT_TIMEOUT_MS,
      );
    } catch (error) {
      this.cachedValue = undefined;
      console.warn("wallet: receipt read failed", errorName(error));
      await this.armReconcile();
      return { ok: false, id, reason: "wallet.error.rpc", inFlight: true };
    }
    this.cachedValue = undefined;

    if (receipt === null) {
      await this.armReconcile();
      return { ok: false, id, reason: "wallet.error.busy", inFlight: true };
    }
    if (receipt.status === "reverted") {
      this.store.markFailed("remittances", id, "wallet.error.reverted");
      return {
        ok: false,
        id,
        reason: "wallet.error.reverted",
        inFlight: false,
      };
    }

    this.store.markConfirmed("remittances", id);
    // The payout is not the principal disappearing; a wallet that the
    // remittance empties must be funded again before it can warn.
    await this.ctx.storage.kv.delete(FUNDED_KEY);
    return { ok: true, id, usdc: Number(usdc) / 1e6, txHash: signed.hash };
  }

  /**
   * Called when reconciliation finds a signed transaction that succeeded.
   * The success path never reaches here, so each remittance is announced once.
   */
  async onRemitConfirmed(row: RemittanceRow): Promise<void> {
    if (row.tx_hash === null) return;
    await this.notifyOwner({
      kind: "wallet.remit",
      id: row.id,
      usdc: toUsd(row.usdc),
      shortUsd: 0,
      txUrl: txUrl(row.tx_hash),
      body: "",
    });
  }

  /** Tells the owner through the Butler; replaced by a stub in tests. */
  async notifyOwner(event: WalletNotice): Promise<void> {
    this.ctx.waitUntil(
      this.notifyButler(event).catch((error) => {
        console.warn("wallet: owner notice failed", errorName(error));
      }),
    );
  }

  private async notifyButler(event: WalletNotice): Promise<void> {
    const butler = this.env.BUTLER.get(
      this.env.BUTLER.idFromName("owner"),
    ) as unknown as RemittanceNotifier;
    await butler.notifyRemittance(event);
  }

  /**
   * Every write reconciles first. Returns the row that blocks new work (a
   * signed transaction still within the unmined grace period), or null.
   */
  private async reconcile(): Promise<JournalRow | null> {
    const resolved = this.resolved();
    await this.backfillTrades();
    for (const row of this.store.pendingAll()) {
      if (row.tx_hash === null) {
        this.store.markFailed(row.table, row.id, "wallet.error.abandoned");
        continue;
      }
      if (resolved === null) return row;

      let receipt: Receipt | null;
      try {
        receipt = await resolved.chain.receipt(
          row.tx_hash,
          RECONCILE_RECEIPT_MS,
        );
      } catch (error) {
        console.warn("wallet: reconcile failed", errorName(error));
        return row;
      }

      if (receipt !== null) {
        if (receipt.status === "success") {
          await this.confirmRow(row);
          continue;
        }
        this.store.markFailed(row.table, row.id, "wallet.error.reverted");
        continue;
      }

      // No receipt: the nonce tells us whether the transaction can still land.
      let tip: number;
      try {
        tip = await resolved.chain.nonce();
      } catch (error) {
        console.warn("wallet: nonce read failed", errorName(error));
        return row;
      }
      const old = getClock().now() - row.at > UNMINED_AFTER_MS;
      if (row.nonce !== null && tip > row.nonce) {
        // Our transaction may have landed between the receipt read and the
        // nonce read, or on a node ahead of the one that answered. Only give
        // up once it is old enough for every node to know, and after one
        // more look at the receipt.
        if (!old) return row;
        let again: Receipt | null;
        try {
          again = await resolved.chain.receipt(
            row.tx_hash,
            RECONCILE_RECEIPT_MS,
          );
        } catch (error) {
          console.warn("wallet: reconcile failed", errorName(error));
          return row;
        }
        if (again?.status === "success") {
          await this.confirmRow(row);
          continue;
        }
        this.store.markFailed(
          row.table,
          row.id,
          again === null ? "wallet.error.replaced" : "wallet.error.reverted",
        );
        continue;
      }

      if (old) {
        if (row.raw !== null) {
          try {
            await resolved.chain.broadcast(row.raw);
          } catch (error) {
            console.warn("wallet: replay failed", errorName(error));
          }
        }
        await this.noticeStuck(row);
        return row;
      }
      return row;
    }

    this.cachedValue = undefined;
    return null;
  }

  /** Marks a row confirmed and runs the hook for its ledger. */
  private async confirmRow(row: JournalRow): Promise<void> {
    this.store.markConfirmed(row.table, row.id);
    if (row.table === "remittances") {
      // A remittance may legitimately leave less than the principal; keep the
      // depleted notice armed for a change in value, not for a payout.
      await this.ctx.storage.kv.delete(FUNDED_KEY);
    }
    try {
      if (row.table === "remittances") {
        const remit = this.store.get(row.id);
        if (remit !== undefined) await this.onRemitConfirmed(remit);
      } else {
        await this.onTradeConfirmed(row);
      }
    } catch (error) {
      console.warn("wallet: confirmation hook failed", errorName(error));
    }
  }

  /**
   * Fills in the value a swap left behind. A transient chain error leaves the
   * row NULL; reconciliation retries it before any further trade is allowed.
   */
  private async onTradeConfirmed(row: JournalRow): Promise<void> {
    if (this.resolved() === null) return;
    this.cachedValue = undefined;
    const valueAfter = await this.valueUsd();
    this.store.setTradeValueAfter(row.id, valueAfter);
    this.cachedValue = undefined;
  }

  /** Retries `value_after` on every confirmed trade still missing it. */
  private async backfillTrades(): Promise<void> {
    if (this.resolved() === null) return;
    const missing = this.store
      .confirmedTrades(0)
      .filter((row) => row.value_after === null);
    if (missing.length === 0) return;
    let valueAfter: number;
    try {
      this.cachedValue = undefined;
      valueAfter = await this.valueUsd();
    } catch (error) {
      console.warn("wallet: trade value read failed", errorName(error));
      return;
    }
    for (const row of missing) {
      this.store.setTradeValueAfter(row.id, valueAfter);
    }
    this.cachedValue = undefined;
  }

  private async hasIncompleteTrades(now: number): Promise<boolean> {
    const since = lossWindowStart(now, await this.resumedAt());
    return this.store
      .confirmedTrades(since)
      .some((row) => row.value_after === null);
  }

  private async resumedAt(): Promise<number | null> {
    return (await this.ctx.storage.kv.get<number>(RESUMED_AT_KEY)) ?? null;
  }

  /** Tells the owner once that a signed transaction is stuck, and why. */
  private async noticeStuck(row: JournalRow): Promise<void> {
    // Remittances keep P1's key so a notice already sent is not repeated.
    const key =
      STUCK_NOTICE_PREFIX +
      (row.table === "remittances" ? row.id : `trade:${row.id}`);
    if (await this.ctx.storage.kv.get<boolean>(key)) return;
    await this.ctx.storage.kv.put(key, true);
    if (row.table === "remittances") {
      const remit = this.store.get(row.id);
      await this.notifyOwner({
        kind: "wallet.remitFailed",
        usdc: remit === undefined ? 0 : toUsd(remit.usdc),
        reason: "wallet.error.stuck",
        body: "",
      });
      return;
    }
    await this.notifyOwner({
      kind: "wallet.tradeStuck",
      reason: "wallet.notice.tradeStuck",
      body: "",
    });
  }

  /** Wakes the object soon to reconcile, unless an earlier alarm exists. */
  private async armReconcile(): Promise<void> {
    const at = getClock().now() + RECONCILE_ALARM_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null && existing <= at) return;
    await this.ctx.storage.setAlarm(at);
  }

  /**
   * The shared hourly alarm: reconcile, sample prices, check the principal,
   * then always leave the next wake-up armed.
   */
  override async alarm(): Promise<void> {
    const resolved = this.resolved();
    if (resolved === null) return;
    try {
      try {
        await this.enqueue(() => this.reconcile());
      } catch (error) {
        console.warn("wallet: alarm reconcile failed", errorName(error));
      }
      await this.samplePrices(resolved.chain);
      await this.checkDepleted(resolved.chain);
    } finally {
      await this.scheduleNext();
    }
  }

  /** One probe per priced token per hour; a failed probe waits for the next. */
  private async samplePrices(chain: ChainPort): Promise<void> {
    const now = getClock().now();
    const hour = Math.floor(now / HOUR_MS);
    if ((await this.ctx.storage.kv.get<number>(SAMPLED_HOUR_KEY)) === hour) {
      return;
    }

    for (const token of ["WETH", "cbBTC"] as const) {
      const decimals = CHAINS.base.tokens[token]?.decimals;
      if (decimals === undefined) continue;
      try {
        const amountOut = await chain.quote("USDC", token, PRICE_PROBE_USDC);
        if (amountOut <= 0n) continue;
        const quantity = Number(amountOut) / 10 ** decimals;
        if (!(quantity > 0)) continue;
        const probeUsd = Number(PRICE_PROBE_USDC) / 1e6;
        this.store.insertPrice(hour, token, probeUsd / quantity);
      } catch (error) {
        console.warn("wallet: price probe failed", errorName(error));
      }
    }

    this.store.deletePricesBefore(
      Math.floor((now - PRICE_KEEP_MS) / HOUR_MS),
    );
    await this.ctx.storage.kv.put(SAMPLED_HOUR_KEY, hour);
  }

  /**
   * Tells the owner once when a funded wallet falls below the trading floor,
   * and re-arms the notice only after the value recovers.
   */
  private async checkDepleted(chain: ChainPort): Promise<void> {
    let valueUsd: number;
    try {
      valueUsd = (await this.holdings(chain)).valueUsd;
    } catch (error) {
      console.warn("wallet: depleted check skipped", errorName(error));
      return;
    }

    if (valueUsd >= MIN_VALUE_USD) {
      await this.ctx.storage.kv.put(FUNDED_KEY, true);
      await this.ctx.storage.kv.delete(DEPLETED_NOTICED_KEY);
      return;
    }
    if (!(await this.ctx.storage.kv.get<boolean>(FUNDED_KEY))) return;
    if (await this.ctx.storage.kv.get<boolean>(DEPLETED_NOTICED_KEY)) return;

    await this.notifyOwner({
      kind: "wallet.depleted",
      valueUsd,
      body: "",
    });
    await this.ctx.storage.kv.put(DEPLETED_NOTICED_KEY, true);
  }

  /** Pending work retries in five minutes; otherwise the next whole hour. */
  private async scheduleNext(): Promise<void> {
    const now = getClock().now();
    const hour = this.nextHour(now);
    const at =
      this.store.pendingAll().length > 0
        ? Math.min(now + RECONCILE_RETRY_MS, hour)
        : hour;
    await this.ctx.storage.setAlarm(at);
  }

  private nextHour(now = getClock().now()): number {
    return (Math.floor(now / HOUR_MS) + 1) * HOUR_MS;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private resolved(): { chain: ChainPort; owner: Address } | null {
    if (chainOverride !== null) return chainOverride;
    const config = walletConfig(this.env);
    if (config === null) return null;
    return {
      chain: new ViemChain(config, "base"),
      owner: config.ownerAddress,
    };
  }

  private async holdings(chain: ChainPort): Promise<Holdings> {
    const [ethWei, usdc, weth, btc] = await Promise.all([
      chain.ethBalance(),
      chain.tokenBalance("USDC"),
      chain.tokenBalance("WETH"),
      chain.tokenBalance("cbBTC"),
    ]);
    const tokens: Record<Token, bigint> = {
      USDC: usdc,
      WETH: weth,
      cbBTC: btc,
    };

    let value = usdc;
    for (const token of ["WETH", "cbBTC"] as const) {
      if (tokens[token] === 0n) continue;
      value += await chain.quote(token, "USDC", tokens[token]);
    }

    return { ethWei, tokens, valueUsd: Number(value) / 1e6 };
  }
}
