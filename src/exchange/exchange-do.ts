import { DurableObject } from "cloudflare:workers";
import type { VenueSnapshot } from "./types";

const SNAPSHOT_PREFIX = "snapshot:";

/**
 * The latest snapshot each account's desktop sync pushed. Deliberately outside
 * the backup: the next sync rebuilds it from Binance.
 */
export class ExchangeDO extends DurableObject<Env> {
  /** Writes only when nothing newer is stored; returns whether it wrote. */
  async put(snapshot: VenueSnapshot): Promise<boolean> {
    const key = SNAPSHOT_PREFIX + snapshot.account;
    const current = await this.ctx.storage.get<VenueSnapshot>(key);
    if (current !== undefined && current.fetchedAt > snapshot.fetchedAt) {
      return false;
    }
    await this.ctx.storage.put(key, snapshot);
    return true;
  }

  async get(accountId: string): Promise<VenueSnapshot | null> {
    return (
      (await this.ctx.storage.get<VenueSnapshot>(SNAPSHOT_PREFIX + accountId)) ??
      null
    );
  }
}

/** The one global snapshot store. */
export function exchangeStub(env: Env): DurableObjectStub<ExchangeDO> {
  return env.EXCHANGE.get(env.EXCHANGE.idFromName("global"));
}
