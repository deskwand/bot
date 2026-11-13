import { DurableObject } from "cloudflare:workers";
import {
  ensureOnce,
  ensureTicker,
  runTick,
  type ScheduledTarget,
  type TickerState,
} from "./ticker";

type FrontEnv = {
  MAIN: Fetcher & ScheduledTarget;
  TICKER: DurableObjectNamespace<TickerDO>;
};

/** Single-instance ticker that drives `main.scheduled()` once a minute. */
export class TickerDO extends DurableObject<FrontEnv> {
  async alarm(): Promise<void> {
    await runTick(this.env.MAIN, this.ctx.storage, Date.now());
  }

  async ensure(): Promise<void> {
    await ensureTicker(this.ctx.storage, Date.now());
  }
}

// Set once a request has started the ticker; later requests skip it.
const tickerState: TickerState = { ensured: false };

export default {
  async fetch(req: Request, env: FrontEnv): Promise<Response> {
    const url = new URL(req.url);
    const ensure = () =>
      env.TICKER.get(env.TICKER.idFromName("global")).ensure();
    if (url.pathname === "/healthz") {
      try {
        await ensure();
        tickerState.ensured = true;
        return new Response("ok", { status: 200 });
      } catch {
        return new Response("unavailable", { status: 503 });
      }
    }
    try {
      await ensureOnce(tickerState, ensure);
    } catch {
      // A ticker failure must not block forwarding; a later request retries.
    }
    return env.MAIN.fetch(req);
  },
};
