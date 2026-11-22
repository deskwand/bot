/**
 * The management view of one invitation. The invite row owns the authoritative
 * end state (pending / consumed / cancelled), the login row owns the process
 * stage, and this module is the only place that merges them: a cancelled
 * invite must never read as "idle", and a login row that has not been written
 * yet must read as "starting".
 */
import type { InviteView, LoginFailure, LoginStage } from "../channels/wechat/login";
import type { InviteRecord } from "./store";

export type AdminInviteStage = "starting" | LoginStage;

export type AdminInviteView = {
  inviteId: string;
  label: string;
  status: "pending" | "consumed" | "cancelled";
  stage: AdminInviteStage;
  expiresAt: number;
  realnameDeadline?: number;
  realnameUrl?: string;
  qrContent?: string;
  failure?: LoginFailure | "unknown";
};

/** The failure vocabulary, typed so a new `LoginFailure` fails the build. */
const FAILURES: Record<LoginFailure, true> = {
  protocol: true,
  realname_denied: true,
  ticket_refresh_exhausted: true,
  ticket_expiring: true,
  credentials_missing: true,
  untrusted_redirect: true,
  binded_elsewhere: true,
  pin_blocked: true,
  invite_not_live: true,
  activation_failed: true,
  expired: true,
  interrupted: true,
};

export function adminInviteView(
  invite: InviteRecord,
  login: InviteView | null,
  now: number,
): AdminInviteView {
  const terminal =
    invite.status === "consumed"
      ? "confirmed"
      : invite.status === "cancelled"
        ? "cancelled"
        : null;
  const stage: AdminInviteStage =
    terminal ??
    (now >= invite.expiresAt
      ? "expired"
      : login === null || login.stage === "idle"
        ? "starting"
        : login.stage);
  const failure = login?.failure;
  return {
    inviteId: invite.inviteId,
    label: invite.label,
    status: invite.status,
    stage,
    expiresAt: invite.expiresAt,
    // The real-name window is shorter than the invite's; the desktop counts
    // down with this value, not with `expiresAt`.
    ...(stage === "realname" && login?.realnameDeadline !== undefined
      ? { realnameDeadline: login.realnameDeadline }
      : {}),
    ...(stage === "realname" && login?.authUrl !== undefined
      ? { realnameUrl: login.authUrl }
      : {}),
    ...(stage === "scan" && login?.qrImage !== undefined
      ? { qrContent: login.qrImage }
      : {}),
    ...(failure === undefined || !Object.hasOwn(FAILURES, failure)
      ? failure === undefined
        ? {}
        : { failure: "unknown" as const }
      : { failure }),
  };
}
