import { DurableObject } from "cloudflare:workers";
import { getClock } from "../butler/notifier";
import { Books, type SpendEntry } from "./books";
import { computeVitals, tierRank, type Tier, type Vitals } from "./vitals";

const NOTIFIED_TIER_KEY = "notified_tier";

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.books = new Books(ctx.storage.sql);
  }

  async recordSpend(entry: SpendEntry): Promise<void> {
    this.books.recordSpend(entry);
    const vitals = computeVitals(this.books.vitalsInput(getClock().now()));
    await this.considerNotice(vitals, true);
  }

  async recordCredit(usd: number, note: string): Promise<Vitals> {
    this.books.recordCredit(getClock().now(), usd, "owner_topup", note);
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
    const vitals = computeVitals(this.books.vitalsInput(now));
    await this.considerNotice(vitals, false);
    return vitals;
  }

  async vitals(): Promise<Vitals> {
    return computeVitals(this.books.vitalsInput(getClock().now()));
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
    const notified =
      (await this.ctx.storage.kv.get<Tier>(NOTIFIED_TIER_KEY)) ?? "ample";
    const changed = onlyWorse
      ? tierRank(vitals.tier) > tierRank(notified)
      : vitals.tier !== notified;
    if (!changed) return;
    await this.ctx.storage.kv.put(NOTIFIED_TIER_KEY, vitals.tier);
    this.ctx.waitUntil(
      this.notifyTierChange(vitals.tier, vitals.runwayDays).catch(console.warn),
    );
  }
}
