/**
 * The invitee-facing bind page. It is deliberately tiny: a page shell, a
 * state read and a PIN submission. Every request carries the invite's bearer
 * token; the token only ever travels in the URL fragment and an Authorization
 * header, never a query string.
 *
 * The routes never expose credentials, tickets or raw QR tokens. What they can
 * show is the invite's own stage and, in the scan stage, the QR image.
 */
import type { InviteView } from "../channels/wechat/login";

export const BIND_PATH = "/members/bind/";
export const BIND_STATE_PATH = "/members/bind/state";
export const BIND_PIN_PATH = "/members/bind/pin";

export type BindChannel = {
  memberBindState(token: string): Promise<BindStateReply>;
  submitMemberBindPin(token: string, pin: string): Promise<BindStateReply>;
};

export type BindStateReply =
  | { ok: true; view: InviteView }
  | { ok: false; status: 401 | 403 | 404 | 410 };

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function headers(extra: Record<string, string> = {}): Headers {
  const result = new Headers(SECURITY_HEADERS);
  for (const [key, value] of Object.entries(extra)) result.set(key, value);
  return result;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: headers({ "content-type": "application/json; charset=utf-8" }),
  });
}

/** The token is a bearer credential; it never comes from a query string. */
function bearer(req: Request): string | null {
  const value = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(value);
  return match?.[1] ?? null;
}

/**
 * Same-origin only: a page on another site must not submit a PIN or read an
 * invite state with a token it happens to hold.
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return req.method === "GET";
  try {
    return new URL(origin).origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

/** The invite's public stage, with a locally rendered QR image. */
function publicState(view: InviteView, renderQr: (text: string) => string) {
  const qrText = view.qrImage;
  return {
    stage: view.stage,
    expiresAt: view.expiresAt,
    ...(view.stage === "scan" && qrText !== undefined
      ? { qrSvg: renderQr(qrText) }
      : {}),
    ...(view.failure === undefined ? {} : { failure: view.failure }),
  };
}

export function createMemberBindRoutes(deps: {
  channel: BindChannel;
  publicBaseUrl: string;
  title: string;
  page: string;
  renderQr: (text: string) => string;
}): { fetch(req: Request): Promise<Response> } {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === BIND_PATH || path === "/members/bind") {
        if (req.method !== "GET") return json({ error: "method" }, 405);
        return new Response(deps.page, {
          status: 200,
          headers: headers({ "content-type": "text/html; charset=utf-8" }),
        });
      }

      if (path !== BIND_STATE_PATH && path !== BIND_PIN_PATH) {
        return json({ error: "not found" }, 404);
      }
      // No token in a query string: only the header form is accepted so a URL
      // that leaks through a log or referrer carries nothing usable.
      if (url.search !== "") return json({ error: "token" }, 401);
      if (!sameOrigin(req)) return json({ error: "origin" }, 403);
      const token = bearer(req);
      if (token === null) return json({ error: "token" }, 401);

      if (path === BIND_STATE_PATH) {
        if (req.method !== "GET") return json({ error: "method" }, 405);
        const reply = await deps.channel.memberBindState(token);
        if (!reply.ok) return json({ error: "invite" }, reply.status);
        return json(publicState(reply.view, deps.renderQr));
      }

      if (req.method !== "POST") return json({ error: "method" }, 405);
      const raw = await req.text();
      if (raw.length > 200) return json({ error: "body" }, 400);
      let pin = "";
      try {
        const body = JSON.parse(raw) as { pin?: unknown };
        if (typeof body.pin === "string") pin = body.pin;
      } catch {
        return json({ error: "body" }, 400);
      }
      if (!/^\d{6}$/.test(pin)) return json({ error: "pin" }, 400);
      const reply = await deps.channel.submitMemberBindPin(token, pin);
      if (!reply.ok) return json({ error: "invite" }, reply.status);
      return json(publicState(reply.view, deps.renderQr));
    },
  };
}

export { SECURITY_HEADERS };
