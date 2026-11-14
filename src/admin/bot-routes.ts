/**
 * Read-only bot routes for the desktop client. Both answers come from the
 * Durable Objects that own the data; nothing here writes, and no maintenance
 * lease is required, so the list stays readable while a backup runs.
 *
 * Reading an id the index no longer knows instantiates its BotDO so it can
 * answer "no record". That is the DO's own empty schema, not deployment data,
 * and it is the only storage touch this route can cause.
 */

import type { BotSnapshot } from "../bot/bot-do";
import type { BotOverviewRow } from "../butler/butler-do";

export const BOTS_PATH = "/admin/bots";

export type BotReads = {
  overview(): Promise<BotOverviewRow[]>;
  snapshot(id: string): Promise<BotSnapshot | null>;
};

export function createBotRoutes(reads: BotReads): {
  fetch(req: Request): Promise<Response>;
} {
  const prefix = `${BOTS_PATH}/`;
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "GET") return notFound();
      if (url.pathname === BOTS_PATH) {
        try {
          return json({ bots: await reads.overview() });
        } catch {
          return json({ code: "BOTS_READ_FAILED" }, 503);
        }
      }
      if (!url.pathname.startsWith(prefix)) return notFound();
      let id: string;
      try {
        id = decodeURIComponent(url.pathname.slice(prefix.length));
      } catch {
        // A malformed percent-encoding is a bad request, not a bot.
        return notFound();
      }
      // An empty id or a nested path is a bad request, not a bot.
      if (id === "" || id.includes("/")) return notFound();
      try {
        const snapshot = await reads.snapshot(id);
        if (snapshot === null) return json({ code: "BOTS_NOT_FOUND" }, 404);
        return json(snapshot);
      } catch {
        return json({ code: "BOTS_READ_FAILED" }, 503);
      }
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}
