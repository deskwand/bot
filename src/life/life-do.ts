import type { Credential } from "@earendil-works/pi-ai";
import { DurableObject } from "cloudflare:workers";
import { BackupRpc } from "../admin/backup-rpc";
import {
  createIndexes,
  type DbSchema,
  type DumpPage,
  type DumpRow,
  type TableSchema,
} from "../admin/sql-dump";
import { getClock } from "../butler/notifier";
import { modelCredentialKey } from "../llm/credential-key";
import {
  walletConfigured,
  walletStub,
} from "../wallet/wallet-do";
import { Books, type SpendEntry } from "./books";
import { computeVitals, tierRank, type Tier, type Vitals } from "./vitals";

const NOTIFIED_TIER_KEY = "notified_tier";
const HOUR_MS = 3_600_000;

/** Just the Butler RPC the ledger needs to reach the owner. */
type TierNotifier = {
  notifyLifeTier(tier: Tier, runwayDays: number | null): Promise<void>;
};

/**
 * The global life ledger: model spend, credits and the vitals derived from
 * them. Every deployment has a single instance, addressed by `lifeStub`.
 */
export class LifeDO extends DurableObject<Env> {
  private readonly books: Books;

  private readonly backup: BackupRpc;

  private cachedVitals: { hour: number; vitals: Vitals } | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.books = new Books(ctx.storage.sql, (closure) =>
      ctx.storage.transactionSync(closure),
    );
    // The ledger has no maintenance lease of its own; the Butler holds it.
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
    await this.backup.restoreBegin(schema);
  }

  async restorePage(table: TableSchema, rows: DumpRow[]): Promise<void> {
    await this.backup.restorePage(table, rows);
  }

  async restoreCommit(schema: DbSchema): Promise<void> {
    // The ledger has no alarm to re-arm, unlike the Butler and the bots.
    createIndexes(this.ctx.storage.sql, schema);
  }

  async restoreReset(): Promise<void> {
    this.backup.restoreReset();
  }

  /**
   * The stored subscription credential for `providerId`, if any. Model
   * credentials live here rather than in Worker secrets because a refresh
   * rotates the refresh token and must be written back; they are excluded
   * from backups.
   */
  async modelCredential(providerId: string): Promise<Credential | undefined> {
    return await this.ctx.storage.kv.get<Credential>(
      modelCredentialKey(providerId),
    );
  }

  async saveModelCredential(
    providerId: string,
    credential: Credential,
  ): Promise<void> {
    await this.ctx.storage.kv.put(modelCredentialKey(providerId), credential);
  }

  /**
   * Compare-and-set on the refresh token. Two Worker isolates can both see the
   * same expired credential and both refresh it; whoever loses this write keeps
   * the winner's credential instead of reviving a rotated-out refresh token.
   * `expectedRefresh` is null when no credential was stored.
   */
  async saveModelCredentialIfCurrent(
    providerId: string,
    expectedRefresh: string | null,
    credential: Credential,
  ): Promise<{ saved: boolean; current: Credential | undefined }> {
    const key = modelCredentialKey(providerId);
    const current = await this.ctx.storage.kv.get<Credential>(key);
    const currentRefresh =
      current === undefined
        ? null
        : current.type === "oauth"
          ? current.refresh
          : undefined;
    if (currentRefresh !== expectedRefresh) {
      return { saved: false, current };
    }
    await this.ctx.storage.kv.put(key, credential);
    return { saved: true, current: credential };
  }

  async deleteModelCredential(providerId: string): Promise<void> {
    await this.ctx.storage.kv.delete(modelCredentialKey(providerId));
  }

  async recordSpend(entry: SpendEntry): Promise<void> {
    this.books.recordSpend(entry);
    this.cachedVitals = undefined;

    const now = getClock().now();
    const input = this.books.vitalsInput(now);
    if (!input.hasCredit) return;
    const vitals = computeVitals(input);
    this.cachedVitals = { hour: Math.floor(now / HOUR_MS), vitals };
    await this.considerNotice(vitals, true);
  }

  async recordCredit(
    usd: number,
    note: string,
    source: "owner_topup" | "earned" = "owner_topup",
  ): Promise<Vitals> {
    this.books.recordCredit(getClock().now(), usd, source, note);
    this.cachedVitals = undefined;
    const vitals = await this.vitals();
    await this.considerNotice(vitals, false);
    return vitals;
  }

  async calibrate(balanceUsd: number, note: string): Promise<Vitals> {
    const now = getClock().now();
    const input = this.books.vitalsInput(now);
    const adjustment =
      balanceUsd - (input.creditTotalUsd - input.spendTotalUsd);
    this.books.recordCredit(now, adjustment, "calibration", note);
    this.cachedVitals = undefined;
    const vitals = await this.vitals();
    await this.considerNotice(vitals, false);
    return vitals;
  }

  async vitals(): Promise<Vitals> {
    const now = getClock().now();
    const hour = Math.floor(now / HOUR_MS);
    if (this.cachedVitals?.hour === hour) return this.cachedVitals.vitals;
    const vitals = computeVitals(this.books.vitalsInput(now));
    this.cachedVitals = { hour, vitals };
    return vitals;
  }

  /** Asks the wallet to remit; replaced by a stub in tests. */
  async requestRemit(vitals: Vitals): Promise<void> {
    if (!walletConfigured(this.env)) return;
    await walletStub(this.env).autoRemit({
      dailySpendUsd: vitals.dailySpendUsd,
      balanceUsd: vitals.balanceUsd,
      metabolismStarted: vitals.metabolismStarted,
    });
  }

  /** Tells the owner through the Butler; replaced by a stub in tests. */
  async notifyTierChange(tier: Tier, runwayDays: number | null): Promise<void> {
    const butler = this.env.BUTLER.get(
      this.env.BUTLER.idFromName("owner"),
    ) as unknown as TierNotifier;
    await butler.notifyLifeTier(tier, runwayDays);
  }

  /**
   * Speaks only on a worsening spend, and on any change after a credit or a
   * calibration, so a tier hovering at a threshold is announced once.
   */
  private async considerNotice(
    vitals: Vitals,
    onlyWorse: boolean,
  ): Promise<void> {
    try {
      const notified =
        (await this.ctx.storage.kv.get<Tier>(NOTIFIED_TIER_KEY)) ?? "ample";
      const changed = onlyWorse
        ? tierRank(vitals.tier) > tierRank(notified)
        : vitals.tier !== notified;
      if (!changed) return;
      await this.ctx.storage.kv.put(NOTIFIED_TIER_KEY, vitals.tier);
      this.ctx.waitUntil(
        this.notifyTierChange(vitals.tier, vitals.runwayDays).catch(
          console.warn,
        ),
      );
      if (tierRank(vitals.tier) > tierRank(notified)) {
        this.ctx.waitUntil(
          this.requestRemit(vitals).catch((error) => {
            console.warn(
              "life: remit request failed",
              error instanceof Error ? error.constructor.name : "Error",
            );
          }),
        );
      }
    } catch (error) {
      console.warn("life: tier notice bookkeeping failed", error);
    }
  }
}
