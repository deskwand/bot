import { DurableObject } from "cloudflare:workers";
import type { MessageEvent } from "../protocol";

/**
 * Control-plane object: the Butler agent lives here. The behaviour lands in a
 * later task; this shell keeps the Durable Object binding resolvable.
 */
export class ButlerDO extends DurableObject<Env> {
  async onMessage(_evt: MessageEvent): Promise<void> {}
}
