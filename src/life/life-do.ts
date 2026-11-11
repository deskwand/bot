import { DurableObject } from "cloudflare:workers";
import { getClock } from "../butler/notifier";
import { Books, type SpendEntry } from "./books";
import { computeVitals, type Vitals } from "./vitals";

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
  }

  async recordCredit(usd: number, note: string): Promise<Vitals> {
    this.books.recordCredit(getClock().now(), usd, "owner_topup", note);
    return this.vitals();
  }

  async calibrate(balanceUsd: number, note: string): Promise<Vitals> {
    const now = getClock().now();
    const input = this.books.vitalsInput(now);
    const adjustment =
      balanceUsd - (input.creditTotalUsd - input.spendTotalUsd);
    this.books.recordCredit(now, adjustment, "calibration", note);
    return computeVitals(this.books.vitalsInput(now));
  }

  async vitals(): Promise<Vitals> {
    return computeVitals(this.books.vitalsInput(getClock().now()));
  }
}
