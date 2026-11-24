/**
 * `/admin/channels`: the channel-shaped admin surface. The legacy
 * `/admin/members` paths stay alive for one version (the desktop upgrade
 * window) and answer the old field names with a `deprecation` header.
 */
import type { ChannelDO } from "../channels/channel-do";
import { ownerPrincipal } from "../members/principal";
import { MemberError } from "../members/store";
import { createMemberAdminRoutes, MEMBERS_PATH } from "./member-routes";

export const CHANNELS_PATH = "/admin/channels";

type ChannelStub = DurableObjectStub<ChannelDO>;

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: HEADERS });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The class does not survive the Durable Object RPC boundary, so a denial
 * arrives as a plain Error carrying `name` and `code`. Classifying on the code
 * is what keeps a refusal from being reported as a 503.
 */
function memberErrorCode(error: unknown): string | null {
  if (error instanceof MemberError) return error.code;
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name !== "MemberError") return null;
  return typeof candidate.code === "string" ? candidate.code : null;
}

function writeError(error: unknown): Response {
  const code = memberErrorCode(error);
  if (code === null) {
    // A fixed code plus the error's own name is enough to diagnose it in the
    // container log; the response stays opaque.
    console.error(
      "admin: channel route failed",
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    );
    return json({ code: "CHANNELS_FAILED" }, 503);
  }
  switch (code) {
    case "MAINTENANCE_ACTIVE":
      return json({ code: "MAINTENANCE_ACTIVE" }, 409);
    case "INVITE_PENDING":
      return json({ code: "INVITE_PENDING" }, 409);
    case "INVITE_NOT_FOUND":
      return json({ code: "CHANNEL_NOT_FOUND" }, 404);
    case "INVITE_EXPIRED":
    case "INVITE_CANCELLED":
    case "INVITE_CONSUMED":
      return json({ code: "INVITE_CLOSED" }, 409);
    case "OWNER_IMMUTABLE":
      return json({ code: "CHANNEL_IMMUTABLE" }, 409);
    case "REBIND_REQUIRED":
      return json({ code: "REBIND_REQUIRED" }, 409);
    case "MEMBER_ACCESS_DENIED":
      return json({ code: "CHANNEL_NOT_FOUND" }, 404);
    default:
      return json({ code: "CHANNELS_FAILED" }, 503);
  }
}

function pinCode(status: 400 | 404 | 409 | 429): string {
  if (status === 400) return "INVALID_PIN";
  if (status === 404) return "CHANNEL_NOT_FOUND";
  if (status === 429) return "PIN_ATTEMPTS_EXHAUSTED";
  return "WRONG_STAGE";
}

async function handle(req: Request, url: URL, channel: ChannelStub): Promise<Response> {
  const path = url.pathname;

  if (req.method === "GET" && path === CHANNELS_PATH) {
    return json({ channels: await channel.adminChannels() });
  }

  if (req.method === "POST" && path === CHANNELS_PATH) {
    const body = await readJson(req);
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (label === "" || label.length > 64) return json({ code: "INVALID_LABEL" }, 400);
    const teen = body.teen === true;
    try {
      return json(
        await channel.createMemberInvite(ownerPrincipal(), label, teen),
        201,
      );
    } catch (error) {
      return writeError(error);
    }
  }

  if (req.method === "GET" && path === `${CHANNELS_PATH}/bindings`) {
    const invites = await channel.adminPendingInvites();
    return json({
      bindings: invites.map((invite) => ({
        inviteId: invite.inviteId,
        label: invite.label,
        kind: invite.kind,
        channelId: invite.memberId,
        expiresAt: invite.expiresAt,
      })),
    });
  }

  const binding = /^\/admin\/channels\/bindings\/([^/]+)(\/pin)?$/.exec(path);
  if (binding !== null) {
    const id = safeDecode(binding[1] as string);
    if (binding[2] === "/pin" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.pin !== "string") return json({ code: "INVALID_PIN" }, 400);
      try {
        const reply = await channel.adminSubmitInvitePin(id, body.pin);
        if (reply.ok) return json(reply.view);
        return json({ code: pinCode(reply.status) }, reply.status);
      } catch (error) {
        return writeError(error);
      }
    }
    if (binding[2] === undefined && req.method === "GET") {
      const reply = await channel.adminInviteState(id);
      return reply.ok ? json(reply.view) : json({ code: "CHANNEL_NOT_FOUND" }, 404);
    }
    if (binding[2] === undefined && req.method === "DELETE") {
      // A pending binding can be abandoned before it is consumed.
      try {
        await channel.cancelMemberInvite(ownerPrincipal(), id);
        return noContent();
      } catch (error) {
        return writeError(error);
      }
    }
    return json({ code: "METHOD" }, 405);
  }

  const target = /^\/admin\/channels\/([^/]+)(\/rebind|\/restart|\/teen)?$/.exec(path);
  if (target !== null) {
    const id = safeDecode(target[1] as string);
    if (target[2] === "/teen" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.teen !== "boolean") {
        return json({ code: "INVALID_MODE" }, 400);
      }
      try {
        await channel.setMemberTeen(ownerPrincipal(), id, body.teen);
        return noContent();
      } catch (error) {
        return writeError(error);
      }
    }
    if (target[2] === "/rebind" && req.method === "POST") {
      try {
        return json(await channel.rebindMember(ownerPrincipal(), id), 201);
      } catch (error) {
        return writeError(error);
      }
    }
    if (target[2] === "/restart" && req.method === "POST") {
      try {
        await channel.restartChannel(ownerPrincipal(), id);
        return noContent();
      } catch (error) {
        return writeError(error);
      }
    }
    if (target[2] === undefined && req.method === "DELETE") {
      try {
        await channel.removeChannel(ownerPrincipal(), id);
        return noContent();
      } catch (error) {
        return writeError(error);
      }
    }
    return json({ code: "METHOD" }, 405);
  }

  return json({ code: "NOT_FOUND" }, 404);
}

/** A malformed percent-escape is a bad path, not a 500. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createChannelAdminRoutes(deps: {
  channel(): ChannelStub;
}): { fetch(req: Request): Promise<Response> } {
  const legacy = createMemberAdminRoutes(deps);
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === CHANNELS_PATH || url.pathname.startsWith(`${CHANNELS_PATH}/`)) {
        return await handle(req, url, deps.channel());
      }
      if (url.pathname === MEMBERS_PATH || url.pathname.startsWith(`${MEMBERS_PATH}/`)) {
        const response = await legacy.fetch(req);
        const deprecated = new Response(response.body, response);
        deprecated.headers.set("deprecation", "true");
        return deprecated;
      }
      return json({ code: "NOT_FOUND" }, 404);
    },
  };
}
