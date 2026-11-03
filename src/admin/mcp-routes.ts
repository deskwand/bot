/**
 * MCP service routes: the authenticated `/admin/mcp/*` management surface and
 * the public OAuth callback. Admin authentication happens in the gateway
 * before any of these paths are dispatched here.
 */

import type { McpAuthDO } from "../mcp/mcp-auth-do";

const PROBE_PATH = "/admin/mcp/probe";
const START_PATH = "/admin/mcp/oauth/start";
const STATUS_PATH = "/admin/mcp/status";
const REVOKE_PREFIX = "/admin/mcp/oauth/";
const CALLBACK_PATH = "/mcp/oauth/callback";

/** Failures the user can act on; any other error stays hidden. */
const USER_ERRORS = new Set([
  "服务不存在",
  "服务不存在或不需要授权",
  "该服务不支持自动注册（DCR）",
]);

/** The success and failure pages are fixed: they never echo the query. */
const SUCCESS_TEXT = "授权完成，可以回到桌面端了";
const FAILURE_TEXT = "授权失败，请回到桌面端重试";

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
  const text = ok ? SUCCESS_TEXT : FAILURE_TEXT;
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${text}</title></head><body>${text}</body></html>`,
    {
      status: ok ? 200 : 400,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      const message = errorMessage(error);
      if (USER_ERRORS.has(message)) return invalid(message);
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
