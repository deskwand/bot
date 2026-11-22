/**
 * Member/user management for the desktop client. The owner identity is derived
 * here, never accepted from the request, and every write is judged by the
 * ChannelDO (maintenance, directory state); this layer only dispatches paths
 * and maps fixed error codes.
 */
import type { ChannelDO } from "../channels/channel-do";
import type { AdminInviteView } from "../members/admin-view";
import { OWNER_ID, ownerPrincipal } from "../members/principal";
import { MemberError } from "../members/store";

export const MEMBERS_PATH = "/admin/members";

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

/** A JSON body, or an empty object when the client sent none. */
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

/** Fixed code for one write failure; the message never reaches the client. */
function writeError(error: unknown, revokedTarget: boolean): Response {
  if (!(error instanceof MemberError)) return json({ code: "MEMBERS_FAILED" }, 503);
  switch (error.code) {
    case "MAINTENANCE_ACTIVE":
      return json({ code: "MAINTENANCE_ACTIVE" }, 409);
    case "INVITE_PENDING":
      return json({ code: "INVITE_PENDING" }, 409);
    case "INVITE_NOT_FOUND":
      return json({ code: "INVITE_NOT_FOUND" }, 404);
    case "INVITE_EXPIRED":
    case "INVITE_CANCELLED":
    case "INVITE_CONSUMED":
      return json({ code: "INVITE_CLOSED" }, 409);
    case "MEMBER_ACCESS_DENIED":
      // Two different causes share this code upstream: an unknown/revoked
      // target, or the owner row, which the caller has already ruled out.
      return json(
        { code: revokedTarget ? "NOT_REBINDABLE" : "MEMBER_NOT_FOUND" },
        revokedTarget ? 409 : 404,
      );
    default:
      return json({ code: "MEMBERS_FAILED" }, 503);
  }
}

export function createMemberAdminRoutes(deps: {
  channel(): ChannelStub;
}): { fetch(req: Request): Promise<Response> } {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const channel = deps.channel();

      if (req.method === "GET" && path === MEMBERS_PATH) {
        const [members, invites] = await Promise.all([
          channel.listMembers(ownerPrincipal()),
          channel.adminPendingInvites(),
        ]);
        const rebinding = new Map(
          invites
            .filter((invite) => invite.kind === "rebind" && invite.memberId !== null)
            .map((invite) => [invite.memberId as string, invite.inviteId]),
        );
        return json({
          users: members.map((member) => ({
            memberId: member.memberId,
            label: member.label,
            role: member.role,
            status: member.status,
            connection: member.connectionStatus,
            inviteId: rebinding.get(member.memberId) ?? null,
          })),
        });
      }

      if (req.method === "GET" && path === `${MEMBERS_PATH}/invites`) {
        const invites = await channel.adminPendingInvites();
        return json({
          invites: invites.map((invite) => ({
            inviteId: invite.inviteId,
            label: invite.label,
            kind: invite.kind,
            memberId: invite.memberId,
            expiresAt: invite.expiresAt,
          })),
        });
      }

      if (req.method === "POST" && path === `${MEMBERS_PATH}/invites`) {
        const body = await readJson(req);
        const label = typeof body.label === "string" ? body.label.trim() : "";
        if (label === "" || label.length > 64) {
          return json({ code: "INVALID_LABEL" }, 400);
        }
        try {
          const link = await channel.createMemberInvite(ownerPrincipal(), label);
          return json(link, 201);
        } catch (error) {
          return writeError(error, false);
        }
      }

      const invite = /^\/admin\/members\/invites\/([^/]+)(\/pin)?$/.exec(path);
      if (invite !== null) {
        const inviteId = safeDecode(invite[1] as string);
        if (invite[2] === "/pin" && req.method === "POST") {
          const body = await readJson(req);
          if (typeof body.pin !== "string") return json({ code: "INVALID_PIN" }, 400);
          let reply: Awaited<ReturnType<ChannelStub["adminSubmitInvitePin"]>>;
          try {
            reply = await channel.adminSubmitInvitePin(inviteId, body.pin);
          } catch (error) {
            return writeError(error, false);
          }
          if (reply.ok) return json(reply.view);
          return json({ code: pinCode(reply.status) }, reply.status);
        }
        if (invite[2] === undefined && req.method === "GET") {
          const reply = await channel.adminInviteState(inviteId);
          if (!reply.ok) return json({ code: "INVITE_NOT_FOUND" }, 404);
          return json(reply.view);
        }
        if (invite[2] === undefined && req.method === "DELETE") {
          const current = await channel.adminInviteState(inviteId);
          if (!current.ok) return json({ code: "INVITE_NOT_FOUND" }, 404);
          const view: AdminInviteView = current.view;
          if (view.status !== "pending" || view.stage === "expired") {
            return json({ code: "INVITE_CLOSED" }, 409);
          }
          try {
            await channel.cancelMemberInvite(ownerPrincipal(), inviteId);
            return noContent();
          } catch (error) {
            return writeError(error, false);
          }
        }
        return json({ code: "METHOD" }, 405);
      }

      const member = /^\/admin\/members\/([^/]+)(\/rebind)?$/.exec(path);
      if (member !== null) {
        const memberId = safeDecode(member[1] as string);
        if (memberId === OWNER_ID) return json({ code: "OWNER_IMMUTABLE" }, 409);
        if (member[2] === "/rebind" && req.method === "POST") {
          try {
            return json(await channel.rebindMember(ownerPrincipal(), memberId), 201);
          } catch (error) {
            return writeError(error, true);
          }
        }
        if (member[2] === undefined && req.method === "DELETE") {
          try {
            await channel.revokeMember(ownerPrincipal(), memberId);
            return noContent();
          } catch (error) {
            return writeError(error, false);
          }
        }
        return json({ code: "METHOD" }, 405);
      }

      return json({ code: "NOT_FOUND" }, 404);
    },
  };
}

/** A malformed percent-escape is a bad path, not a 500. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function pinCode(status: 400 | 404 | 409 | 429): string {
  if (status === 400) return "INVALID_PIN";
  if (status === 404) return "INVITE_NOT_FOUND";
  if (status === 429) return "PIN_ATTEMPTS_EXHAUSTED";
  return "WRONG_STAGE";
}
