/**
 * Owner-only member management, as model-facing tools.
 *
 * Every tool here is registered exclusively in the owner's Butler registry and
 * carries the owner Principal captured at registration time: a member object
 * never installs these, and a model-supplied `role` or `member_id` cannot
 * promote the actor. The only secret that ever leaves this module is the
 * one-time binding link the owner is expected to forward — its token lives in
 * the URL fragment, and no qrcode, ticket or bot token is ever part of a tool
 * result.
 */
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { t, tryT, type Locale } from "../i18n";
import { OWNER_ID, type Principal } from "./principal";
import {
  MEMBER_ACCESS_DENIED,
  MemberError,
  type MemberInviteLink,
  type MemberView,
} from "./store";

/** The owner-only runtime surface these tools call. */
export type MemberAdminRpc = {
  listMembers(actor: Principal): Promise<MemberView[]>;
  createMemberInvite(actor: Principal, label: string): Promise<MemberInviteLink>;
  rebindMember(actor: Principal, memberId: string): Promise<MemberInviteLink>;
  cancelMemberInvite(actor: Principal, inviteId: string): Promise<void>;
  revokeMember(actor: Principal, memberId: string): Promise<void>;
};

export type MemberToolDeps = {
  /** Proven at registration; never taken from tool arguments. */
  actor: Principal;
  channel: MemberAdminRpc;
  locale: Locale;
};

const InviteMember = Type.Object({ label: Type.String() });

const RebindMember = Type.Object({ member_id: Type.String() });

const CancelInvite = Type.Object({ invite_id: Type.String() });

const ListMembers = Type.Object({});

const RevokeMember = Type.Object({ member_id: Type.String() });

/** Only the machine that runs the deployment can open a loopback link. */
function isLoopback(url: string): boolean {
  try {
    // `URL` keeps the brackets on an IPv6 host, so only that form appears.
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function output(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

/** Only the owner's own id and role pass; the directory is checked downstream. */
function isOwner(actor: Principal): boolean {
  return actor.memberId === OWNER_ID && actor.role === "owner";
}

function deadline(ms: number): string {
  return new Date(ms).toISOString();
}

function roleText(locale: Locale, member: MemberView): string {
  return member.role === "owner"
    ? t(locale, "member.list.owner")
    : t(locale, "member.list.member");
}

function statusText(locale: Locale, member: MemberView): string {
  return member.status === "revoked"
    ? t(locale, "member.list.revoked")
    : t(locale, "member.list.active");
}

/** Fixed diagnostic code, mapped to a fixed sentence. Never raw error text. */
function errorText(locale: Locale, error: unknown): string {
  if (error instanceof MemberError) {
    const known = tryT(locale, `member.errors.${error.code}`);
    if (known !== undefined) return known;
    if (error.code === MEMBER_ACCESS_DENIED) return t(locale, "member.denied");
    return t(locale, "member.error", { code: error.code });
  }
  return t(locale, "member.error", { code: "INTERNAL_ERROR" });
}

/**
 * The owner's member-management tools. Like the other management tools they
 * answer with text and never throw: the model explains the failure to the
 * owner, and a denial is a sentence rather than an exception.
 */
export function createMemberTools(deps: MemberToolDeps): ToolRegistration[] {
  const { actor, channel, locale } = deps;

  /** Denial and failure both answer text; the runtime is never reached. */
  const run = async (call: () => Promise<string>): Promise<ReturnType<typeof output>> => {
    if (!isOwner(actor)) return output(t(locale, "member.denied"));
    try {
      return output(await call());
    } catch (error) {
      return output(errorText(locale, error));
    }
  };

  /**
   * A loopback deployment cannot hand out a page, so its lead points at the
   * QR images instead of asking the owner to forward a link that cannot open.
   * The URL stays for one purpose only: typing the PIN on the host machine.
   */
  const invitation = (
    link: MemberInviteLink,
    lead: string,
    localLead: string,
  ): string =>
    `${isLoopback(link.bindUrl) ? localLead : lead}\n${link.bindUrl}`;

  return [
    {
      name: "invite_member",
      description:
        "Create a one-time WeChat binding link for a new member and hand the link over.",
      parameters: InviteMember,
      execute: (args: { label: string }) =>
        run(async () => {
          const link = await channel.createMemberInvite(actor, args.label);
          return invitation(
            link,
            t(locale, "member.inviteCreated", {
              inviteId: link.inviteId,
              expiresAt: deadline(link.expiresAt),
            }),
            t(locale, "member.inviteLocal", {
              inviteId: link.inviteId,
              expiresAt: deadline(link.expiresAt),
            }),
          );
        }),
    },
    {
      name: "rebind_member",
      description:
        "Create a one-time link that lets an existing member bind a replacement WeChat account.",
      parameters: RebindMember,
      execute: (args: { member_id: string }) =>
        run(async () => {
          const link = await channel.rebindMember(actor, args.member_id);
          return invitation(
            link,
            t(locale, "member.rebindCreated", {
              inviteId: link.inviteId,
              expiresAt: deadline(link.expiresAt),
            }),
            t(locale, "member.rebindLocal", {
              inviteId: link.inviteId,
              expiresAt: deadline(link.expiresAt),
            }),
          );
        }),
    },
    {
      name: "cancel_member_invite",
      description: "Cancel a pending member invitation and its binding link.",
      parameters: CancelInvite,
      execute: (args: { invite_id: string }) =>
        run(async () => {
          await channel.cancelMemberInvite(actor, args.invite_id);
          return t(locale, "member.cancelled", { inviteId: args.invite_id });
        }),
    },
    {
      name: "list_members",
      description: "List the owner and every member with its status.",
      parameters: ListMembers,
      execute: () =>
        run(async () => {
          const members = await channel.listMembers(actor);
          if (members.length === 0) return t(locale, "member.list.empty");
          const lines = members.map((member) =>
            t(locale, "member.list.line", {
              label: member.label,
              memberId: member.memberId,
              role: roleText(locale, member),
              status: statusText(locale, member),
            }),
          );
          return [
            t(locale, "member.list.header", { count: members.length }),
            ...lines,
          ].join("\n");
        }),
    },
    {
      name: "revoke_member",
      description:
        "Revoke a member: disconnect its WeChat account and invalidate its access.",
      parameters: RevokeMember,
      execute: (args: { member_id: string }) =>
        run(async () => {
          await channel.revokeMember(actor, args.member_id);
          return t(locale, "member.revoked", { memberId: args.member_id });
        }),
    },
  ];
}
