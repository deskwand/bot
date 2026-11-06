/**
 * MCP service routes: the authenticated `/admin/mcp/*` management surface and
 * the public OAuth callback. Admin authentication happens in the gateway
 * before any of these paths are dispatched here.
 */

import { t, type Locale } from "../i18n";
import type { McpAuthDO } from "../mcp/mcp-auth-do";
import {
  mcpUserErrorCode,
  type McpUserErrorCode,
} from "../mcp/errors";
import { mcpErrorText } from "../mcp/owner-copy";

const PROBE_PATH = "/admin/mcp/probe";
const START_PATH = "/admin/mcp/oauth/start";
const STATUS_PATH = "/admin/mcp/status";
const REVOKE_PREFIX = "/admin/mcp/oauth/";
const CALLBACK_PATH = "/mcp/oauth/callback";

/** Failures the user can act on; any other error stays hidden. */
function userError(locale: Locale, code: McpUserErrorCode): Response {
  return json({ code, error: mcpErrorText(locale, code) }, 400);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function invalid(message: string): Response {
  return json({ code: "MCP_INVALID", message }, 400);
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function page(ok: boolean): Response {
  // The browser follows the system language, which may differ from the
  // owner's choice, so the page always carries both languages.
  const key = ok ? "mcp.callbackSuccess" : "mcp.callbackFailure";
  const zh = t("zh", key);
  const en = t("en", key);
  return new Response(
    `<!doctype html><html lang="mul"><head><meta charset="utf-8"><title>DeskWand Bot</title></head><body><p>${zh}</p><p lang="en">${en}</p></body></html>`,
    {
      status: ok ? 200 : 400,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function readName(req: Request): Promise<string | null> {
  try {
    const body = (await req.json()) as { name?: unknown };
    if (typeof body.name !== "string" || body.name === "") return null;
    return body.name;
  } catch {
    return null;
  }
}

export function createMcpAdminRoutes(
  mcpAuth: () => DurableObjectStub<McpAuthDO>,
  locale: () => Locale = () => "zh",
): { fetch(req: Request): Promise<Response> } {
  async function callback(url: URL): Promise<Response> {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code === null || code === "" || state === null || state === "") {
      return page(false);
    }
    return page(await mcpAuth().completeAuthorization(state, code));
  }

  async function probe(req: Request): Promise<Response> {
    const name = await readName(req);
    if (name === null) return invalid("probe needs { name }");
    return json(await mcpAuth().probe(name));
  }

  async function start(req: Request): Promise<Response> {
    const name = await readName(req);
    if (name === null) return invalid("start needs { name }");
    try {
      return json(await mcpAuth().startAuthorization(name));
    } catch (error) {
      // Only fixed, user-actionable reasons are returned; network failures
      // must not leak their details.
      const code = mcpUserErrorCode(error);
      if (code !== null) return userError(locale(), code);
      throw error;
    }
  }

  async function revoke(url: URL): Promise<Response> {
    let name: string;
    try {
      name = decodeURIComponent(url.pathname.slice(REVOKE_PREFIX.length));
    } catch {
      return notFound();
    }
    if (name === "") return notFound();

    await mcpAuth().revoke(name);
    return new Response(null, { status: 204 });
  }

  async function handle(req: Request, url: URL): Promise<Response> {
    if (req.method === "GET" && url.pathname === CALLBACK_PATH) {
      return callback(url);
    }
    if (req.method === "POST" && url.pathname === PROBE_PATH) {
      return probe(req);
    }
    if (req.method === "POST" && url.pathname === START_PATH) {
      return start(req);
    }
    if (req.method === "GET" && url.pathname === STATUS_PATH) {
      return json({ servers: await mcpAuth().status() });
    }
    if (
      req.method === "DELETE" &&
      url.pathname.startsWith(REVOKE_PREFIX)
    ) {
      return revoke(url);
    }
    return notFound();
  }

  return {
    async fetch(req: Request): Promise<Response> {
      try {
        return await handle(req, new URL(req.url));
      } catch {
        // Never echo the thrown error: it may contain tokens or URLs.
        return json(
          { code: "MCP_FAILED", message: "mcp request failed" },
          500,
        );
      }
    },
  };
}
