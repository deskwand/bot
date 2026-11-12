/**
 * Life vitals route: one authenticated read for the desktop home page. The
 * vitals are derived from the life ledger and never written here; a read that
 * fails answers with a fixed code instead of an empty or partial payload.
 */

import type { Vitals } from "../life/vitals";

export const LIFE_VITALS_PATH = "/admin/life/vitals";

export type LifeReads = {
  vitals(): Promise<Vitals>;
};

export function createLifeRoutes(reads: LifeReads): {
  fetch(req: Request): Promise<Response>;
} {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "GET" || url.pathname !== LIFE_VITALS_PATH) {
        return new Response("Not found", { status: 404 });
      }
      try {
        return json(await reads.vitals());
      } catch {
        return json({ code: "LIFE_VITALS_FAILED" }, 503);
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
