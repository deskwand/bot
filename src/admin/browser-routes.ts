/**
 * Takeover routes for the desktop client's browser panel. Nothing here touches
 * the database: the sandbox owns the tab, this only forwards. Frames are never
 * stored - the stream response is passed through with its body untouched.
 */

import type { BrowserClient, MirrorInput } from "../sandbox/browser-http";

export const BROWSER_PREFIX = "/admin/browser";

export type BrowserAdminDeps = { client: BrowserClient | null };

export type BrowserStatus = {
  available: boolean;
  reason?: "no-sandbox" | "image-too-old" | "sandbox-unreachable";
};

export function createBrowserAdminRoutes(deps: BrowserAdminDeps): {
  fetch(req: Request): Promise<Response>;
} {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (!url.pathname.startsWith(BROWSER_PREFIX)) return notFound();

      if (req.method === "GET" && url.pathname === `${BROWSER_PREFIX}/status`) {
        return json(await statusOf(deps.client));
      }

      if (deps.client === null) return json({ code: "BROWSER_UNAVAILABLE" }, 503);

      if (req.method === "GET" && url.pathname === `${BROWSER_PREFIX}/mirror`) {
        try {
          const upstream = await deps.client.mirrorStream(req.signal);
          return new Response(upstream.body, {
            status: 200,
            headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
          });
        } catch {
          return json({ code: "SANDBOX_UNAVAILABLE" }, 502);
        }
      }

      if (req.method === "POST" && url.pathname === `${BROWSER_PREFIX}/open`) {
        const body = (await readJson(req)) as { url?: unknown };
        const target = typeof body.url === "string" ? body.url : "";
        try {
          return json(await deps.client.openMirror(target === "" ? undefined : target));
        } catch {
          return json({ code: "SANDBOX_UNAVAILABLE" }, 502);
        }
      }

      if (req.method === "POST" && url.pathname === `${BROWSER_PREFIX}/input`) {
        const body = (await readJson(req)) as { seq?: unknown; events?: unknown };
        const seq = typeof body.seq === "number" ? body.seq : -1;
        const events = Array.isArray(body.events) ? (body.events as MirrorInput[]) : [];
        try {
          return json(await deps.client.mirrorInput(seq, events));
        } catch {
          return json({ code: "SANDBOX_UNAVAILABLE" }, 502);
        }
      }

      if (req.method === "POST" && url.pathname === `${BROWSER_PREFIX}/close`) {
        try {
          await deps.client.closeMirror();
          return json({ ok: true });
        } catch {
          return json({ code: "SANDBOX_UNAVAILABLE" }, 502);
        }
      }

      return notFound();
    },
  };
}

/** Three different sentences for the page, so none of them misleads the owner. */
async function statusOf(client: BrowserClient | null): Promise<BrowserStatus> {
  if (client === null) return { available: false, reason: "no-sandbox" };
  try {
    const features = await client.features();
    if (!features.includes("browser-mirror")) {
      return { available: false, reason: "image-too-old" };
    }
    return { available: true };
  } catch {
    return { available: false, reason: "sandbox-unreachable" };
  }
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
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
