import { DurableObject } from "cloudflare:workers";
import { MemoryStore } from "../butler/memory";
import { BotStore } from "./bot-store";

/**
 * Long-lived identity for one autonomous bot: mission, memories, run log and
 * wake time. It never runs a model; every wake goes through the Butler, which
 * dispatches a TaskDO and reports the outcome back here.
 */
export class BotDO extends DurableObject<Env> {
  readonly store: BotStore;

  readonly memories: MemoryStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new BotStore(ctx.storage.sql);
    this.memories = new MemoryStore(ctx.storage.sql);
  }
}
