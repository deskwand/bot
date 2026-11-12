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
  type ChainPort,
  type Receipt,
  type Signed,
  type Token,
  type TxRequest,
} from "./chain";
import { walletConfig } from "./config";
import {
  checkRemit,
  MIN_REMIT_USD,
  RECEIPT_TIMEOUT_MS,
  RECONCILE_RECEIPT_MS,
  remitAmountUsd,
  UNMINED_AFTER_MS,
  type Holdings,
} from "./guard";
import { WalletStore, type RemittanceRow } from "./store";
import { assertAllowedTarget, transferTx } from "./tx";
import { ViemChain } from "./viem-chain";

const HOUR_MS = 3_600_000;
/** How soon the reconcile alarm fires after a signed transaction stays open. */
const RECONCILE_ALARM_MS = 2 * 60_000;
/** How soon to try again while a signed transaction is still pending. */
const RECONCILE_RETRY_MS = 5 * 60_000;
const STUCK_NOTICE_PREFIX = "stuck_noticed:";
/** Admin-facing English; this is not spoken by the model. */
const RESTORE_IN_FLIGHT =
  "a remittance is still in flight; retry the restore in a few minutes";

export type WalletStatus = {
  address: Address;
  holdings: Holdings;
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
  | { kind: "wallet.remitFailed"; usdc: number; reason: string; body: "" };

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

function txUrl(hash: Hex): string {
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
      if (this.store.hasTable() && this.store.pending().length > 0) {
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
      if (this.store.hasTable() && this.store.pending().length > 0) {
        throw new Error(RESTORE_IN_FLIGHT);
      }
      this.backup.restoreReset();
    });
  }

  async status(): Promise<WalletStatus> {
    const resolved = this.resolved();
    if (resolved === null) throw new Error("wallet is not configured");
    const holdings = await this.holdings(resolved.chain);
    const pending = this.store.pendingRemittance(getClock().now());
    return {
      address: resolved.chain.address,
      holdings,
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
      this.store.markFailed(id, errorName(error));
      this.cachedValue = undefined;
      console.warn("wallet: transfer build failed", errorName(error));
      return { ok: false, id, reason: "wallet.error.rpc", inFlight: false };
    }

    let signed: Signed;
    try {
      signed = await resolved.chain.sign(tx);
    } catch (error) {
      this.store.markFailed(id, errorName(error));
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
      this.store.markFailed(id, "wallet.error.reverted");
      return {
        ok: false,
        id,
        reason: "wallet.error.reverted",
        inFlight: false,
      };
    }

    this.store.markConfirmed(id);
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
  private async reconcile(): Promise<RemittanceRow | null> {
    const resolved = this.resolved();
    if (!this.store.hasTable()) return null;
    for (const row of this.store.pending()) {
      if (row.tx_hash === null) {
        this.store.markFailed(row.id, "wallet.error.abandoned");
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
          this.store.markConfirmed(row.id);
          try {
            await this.onRemitConfirmed({ ...row, status: "confirmed" });
          } catch (error) {
            console.warn("wallet: confirmation hook failed", errorName(error));
          }
          continue;
        }
        this.store.markFailed(row.id, "wallet.error.reverted");
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
          this.store.markConfirmed(row.id);
          try {
            await this.onRemitConfirmed({ ...row, status: "confirmed" });
          } catch (error) {
            console.warn("wallet: confirmation hook failed", errorName(error));
          }
          continue;
        }
        this.store.markFailed(
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

  /** Tells the owner once that a signed transfer is stuck, and why. */
  private async noticeStuck(row: RemittanceRow): Promise<void> {
    const key = STUCK_NOTICE_PREFIX + row.id;
    if (await this.ctx.storage.kv.get<boolean>(key)) return;
    await this.ctx.storage.kv.put(key, true);
    await this.notifyOwner({
      kind: "wallet.remitFailed",
      usdc: toUsd(row.usdc),
      reason: "wallet.error.stuck",
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
   * The reconcile sweep. A signed transaction is never abandoned until its
   * nonce is spent; an unmined one is replayed verbatim instead of re-signed.
   */
  override async alarm(): Promise<void> {
    if (this.resolved() === null) return;
    await this.enqueue(() => this.reconcile());
    if (this.store.hasTable() && this.store.pending().length > 0) {
      await this.ctx.storage.setAlarm(
        getClock().now() + RECONCILE_RETRY_MS,
      );
    }
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
