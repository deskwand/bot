/**
 * Two-step sharing between the owner and members.
 *
 * `prepare` freezes a preview: the sender must already own every attachment
 * (the ACL row, never the role, decides that), and the bytes are digested at
 * that moment. Nothing leaves the sender yet. `confirm` is the only step that
 * can deliver: it claims the row with a single conditional write, re-checks
 * both principals and every digest, copies the bytes into the recipient's own
 * inbox namespace (`inbox/share-<shareId>/…`) with a fresh ACL row for the
 * recipient, and only then hands the text and files to the channel.
 *
 * The sender's original stays exactly where it was, owned by the sender. There
 * is no ambiguous middle state: a share is either pending (nothing sent), torn
 * down before sending (cancelled/expired/invalid, nothing sent), or terminal
 * `sent`. A failure after delivery started is `interrupted` and is never
 * retried automatically, so a member cannot receive the same share twice.
 */
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { MAX_ARTIFACT_BYTES, artifactNameFromKey } from "../artifact";
import { t, tryT, type Locale } from "../i18n";
import { AttachmentAccess } from "./artifact-access";
import { MEMBER_ACCESS_DENIED, MemberError, type MemberView } from "./store";
import type { Principal } from "./principal";

/** Plan: a prepared share has to be confirmed within ten minutes. */
export const SHARE_TTL_MS = 10 * 60 * 1000;
export const SHARE_MAX_FILES = 5;
/** The same 15MB budget every channel can actually carry. */
export const SHARE_MAX_BYTES = MAX_ARTIFACT_BYTES;
/** Recipient copies live in their own namespace, one folder per share. */
export const SHARE_COPY_PREFIX = "inbox/share-";

export const SHARE_NOT_FOUND = "SHARE_NOT_FOUND";
export const SHARE_RECIPIENT_UNKNOWN = "SHARE_RECIPIENT_UNKNOWN";
export const SHARE_RECIPIENT_AMBIGUOUS = "SHARE_RECIPIENT_AMBIGUOUS";
export const SHARE_EMPTY = "SHARE_EMPTY";
export const SHARE_TOO_MANY_FILES = "SHARE_TOO_MANY_FILES";
export const SHARE_TOO_LARGE = "SHARE_TOO_LARGE";
export const SHARE_ATTACHMENT_MISSING = "SHARE_ATTACHMENT_MISSING";
export const SHARE_DIGEST_MISMATCH = "SHARE_DIGEST_MISMATCH";
export const SHARE_EXPIRED = "SHARE_EXPIRED";
export const SHARE_INVALID = "SHARE_INVALID";
export const SHARE_INTERRUPTED = "SHARE_INTERRUPTED";

export type ShareStatus =
  | "pending"
  | "sending"
  | "sent"
  | "cancelled"
  | "expired"
  | "invalid"
  | "interrupted";

/** What a recipient copy is made from: name, type, size and digest. */
export type ShareAttachment = {
  key: string;
  name: string;
  mime: string;
  size: number;
  digest: string;
};

/** The preview `prepare` returns. No bytes and no copy exist yet. */
export type SharePreview = {
  shareId: string;
  expiresAt: number;
  recipientLabel: string;
  text: string;
  files: string[];
};

export type ShareResult = {
  shareId: string;
  status: ShareStatus;
  delivered: number;
};

/** Where the confirmed share is delivered. Owner and member paths differ. */
export type ShareDelivery = {
  text(actor: Principal, text: string): Promise<void>;
  file(actor: Principal, key: string): Promise<void>;
};

/** The directory slice sharing needs: liveness now, labels at prepare time. */
export type ShareDirectory = {
  assertActive(actor: Principal): void;
  list(): MemberView[];
};

export type ShareSource = { bytes: Uint8Array; mime: string };

export type ShareServiceDeps = {
  sql: SqlStorage;
  members: ShareDirectory;
  access: AttachmentAccess;
  read(key: string): Promise<ShareSource | null>;
  write(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  deliver: ShareDelivery;
  now?: () => number;
  digest?: (bytes: Uint8Array) => Promise<string>;
};

type ShareRow = {
  share_id: string;
  sender_id: string;
  sender_epoch: number;
  recipient_id: string;
  recipient_label: string;
  recipient_epoch: number;
  text: string;
  attachments: string;
  status: string;
  created_at: number;
  expires_at: number;
  updated_at: number;
};

export async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function attachmentsOf(row: ShareRow): ShareAttachment[] {
  try {
    const parsed: unknown = JSON.parse(row.attachments);
    return Array.isArray(parsed) ? (parsed as ShareAttachment[]) : [];
  } catch {
    return [];
  }
}

export class ShareService {
  private readonly sql: SqlStorage;

  private readonly members: ShareDirectory;

  private readonly access: AttachmentAccess;

  private readonly read: ShareServiceDeps["read"];

  private readonly write: ShareServiceDeps["write"];

  private readonly deliver: ShareDelivery;

  private readonly now: () => number;

  private readonly digest: (bytes: Uint8Array) => Promise<string>;

  constructor(deps: ShareServiceDeps) {
    this.sql = deps.sql;
    this.members = deps.members;
    this.access = deps.access;
    this.read = deps.read;
    this.write = deps.write;
    this.deliver = deps.deliver;
    this.now = deps.now ?? (() => Date.now());
    this.digest = deps.digest ?? digestHex;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS member_shares (
        share_id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        sender_epoch INTEGER NOT NULL,
        recipient_id TEXT NOT NULL,
        recipient_label TEXT NOT NULL,
        recipient_epoch INTEGER NOT NULL,
        text TEXT NOT NULL,
        attachments TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS member_share_seq (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        n INTEGER NOT NULL
      )`,
    );
  }

  /**
   * Label lookup at prepare time. Only a single active member matches; the
   * caller asks the human instead of guessing when two share a label.
   */
  resolveRecipient(label: string): MemberView {
    const wanted = label.trim().toLowerCase();
    if (wanted === "") throw new MemberError(SHARE_RECIPIENT_UNKNOWN);
    const active = this.members
      .list()
      .filter((member) => member.status === "active");
    const exact = active.find((member) => member.memberId === label.trim());
    if (exact) return exact;
    const matches = active.filter(
      (member) => member.label.trim().toLowerCase() === wanted,
    );
    if (matches.length === 0) throw new MemberError(SHARE_RECIPIENT_UNKNOWN);
    if (matches.length > 1) throw new MemberError(SHARE_RECIPIENT_AMBIGUOUS);
    return matches[0]!;
  }

  /** `prepare_share` for a human-spelled label. */
  async prepareByLabel(
    sender: Principal,
    recipientLabel: string,
    text: string,
    attachmentKeys: string[],
  ): Promise<SharePreview> {
    const recipient = this.resolveRecipient(recipientLabel);
    return this.prepare(sender, recipient.memberId, text, attachmentKeys);
  }

  /**
   * Freezes the share. Every attachment must already be owned by the sender
   * through the ACL table — being the owner is not a substitute — and the
   * bytes are read and digested now, so a later swap is detectable.
   */
  async prepare(
    sender: Principal,
    recipientId: string,
    text: string,
    attachmentKeys: string[],
  ): Promise<SharePreview> {
    this.members.assertActive(sender);
    const body = text.trim();
    const keys = Array.from(
      new Set(attachmentKeys.filter((key) => key !== "")),
    );
    if (keys.length > SHARE_MAX_FILES) {
      throw new MemberError(SHARE_TOO_MANY_FILES);
    }
    if (body === "" && keys.length === 0) throw new MemberError(SHARE_EMPTY);
    const recipient = this.activeMember(recipientId);

    const attachments: ShareAttachment[] = [];
    let total = 0;
    for (const key of keys) {
      if (!this.access.owns(sender.memberId, key)) {
        throw new MemberError(MEMBER_ACCESS_DENIED);
      }
      const source = await this.read(key);
      if (source === null) throw new MemberError(SHARE_ATTACHMENT_MISSING);
      total += source.bytes.byteLength;
      if (total > SHARE_MAX_BYTES) throw new MemberError(SHARE_TOO_LARGE);
      attachments.push({
        key,
        name: artifactNameFromKey(key),
        mime: source.mime,
        size: source.bytes.byteLength,
        digest: await this.digest(source.bytes),
      });
    }

    const now = this.now();
    const shareId = `sh${this.nextSeq()}`;
    this.sql.exec(
      `INSERT INTO member_shares (
        share_id, sender_id, sender_epoch, recipient_id, recipient_label,
        recipient_epoch, text, attachments, status, created_at, expires_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      shareId,
      sender.memberId,
      sender.epoch,
      recipient.memberId,
      recipient.label,
      recipient.epoch,
      body,
      JSON.stringify(attachments),
      now,
      now + SHARE_TTL_MS,
      now,
    );

    return {
      shareId,
      expiresAt: now + SHARE_TTL_MS,
      recipientLabel: recipient.label,
      text: body,
      files: attachments.map((attachment) => attachment.key),
    };
  }

  /**
   * The only delivery path. The first conditional write wins; a second
   * `确认分享` sees a non-pending row and sends nothing.
   */
  async confirm(sender: Principal, shareId: string): Promise<ShareResult> {
    this.members.assertActive(sender);
    const row = this.row(shareId);
    // A share addressed to someone else is indistinguishable from a missing
    // one: the reply never confirms that another member's share exists.
    if (!row || row.sender_id !== sender.memberId) {
      throw new MemberError(SHARE_NOT_FOUND);
    }
    const claimed = this.sql
      .exec(
        `UPDATE member_shares SET status = 'sending', updated_at = ?
         WHERE share_id = ? AND sender_id = ? AND status = 'pending'`,
        this.now(),
        row.share_id,
        sender.memberId,
      )
      .rowsWritten;
    if (claimed !== 1) throw new MemberError(SHARE_NOT_FOUND);

    // Past this point the row belongs to this call: every failure must land on
    // a terminal status, so no retry can deliver twice.
    if (this.now() > row.expires_at) {
      this.setStatus(row.share_id, "expired", this.now());
      throw new MemberError(SHARE_EXPIRED);
    }
    if (row.sender_epoch !== sender.epoch) {
      this.setStatus(row.share_id, "invalid", this.now());
      throw new MemberError(SHARE_INVALID);
    }
    try {
      this.members.assertActive(sender);
    } catch {
      this.setStatus(row.share_id, "invalid", this.now());
      throw new MemberError(MEMBER_ACCESS_DENIED);
    }

    let recipient: MemberView;
    try {
      recipient = this.activeMember(row.recipient_id);
    } catch {
      this.setStatus(row.share_id, "invalid", this.now());
      throw new MemberError(MEMBER_ACCESS_DENIED);
    }
    if (recipient.epoch !== row.recipient_epoch) {
      this.setStatus(row.share_id, "invalid", this.now());
      throw new MemberError(MEMBER_ACCESS_DENIED);
    }

    // Re-read every byte: a changed object must block the send, not ship a
    // version the sender never previewed.
    const attachments = attachmentsOf(row);
    const sources: ShareSource[] = [];
    for (const attachment of attachments) {
      const source = await this.read(attachment.key);
      if (
        source === null ||
        source.bytes.byteLength !== attachment.size ||
        (await this.digest(source.bytes)) !== attachment.digest
      ) {
        this.setStatus(row.share_id, "invalid", this.now());
        throw new MemberError(SHARE_DIGEST_MISMATCH);
      }
      sources.push(source);
    }

    const recipientActor: Principal = {
      memberId: recipient.memberId,
      role: recipient.role,
      epoch: recipient.epoch,
    };
    const copies: string[] = [];
    let delivered = 0;
    try {
      for (let i = 0; i < attachments.length; i += 1) {
        const attachment = attachments[i]!;
        const key = `${SHARE_COPY_PREFIX}${row.share_id}/${attachment.name}`;
        await this.write(key, sources[i]!.bytes, attachment.mime);
        // The copy is the recipient's own artifact from here on; the original
        // ACL row is untouched and still belongs to the sender.
        this.access.record(recipient.memberId, key);
        copies.push(key);
      }
      if (row.text !== "") {
        await this.deliver.text(recipientActor, row.text);
        delivered += 1;
      }
      for (const key of copies) {
        await this.deliver.file(recipientActor, key);
        delivered += 1;
      }
    } catch {
      // Delivery started (or the copies are half written): stop, mark it, and
      // never retry on its own.
      this.setStatus(row.share_id, "interrupted", this.now());
      throw new MemberError(SHARE_INTERRUPTED);
    }

    this.setStatus(row.share_id, "sent", this.now());
    return { shareId: row.share_id, status: "sent", delivered };
  }

  /** Sender-only teardown of a pending share. Nothing is reported to others. */
  cancel(sender: Principal, shareId: string): boolean {
    this.members.assertActive(sender);
    const written = this.sql
      .exec(
        `UPDATE member_shares SET status = 'cancelled', updated_at = ?
         WHERE share_id = ? AND sender_id = ? AND status = 'pending'`,
        this.now(),
        shareId,
        sender.memberId,
      )
      .rowsWritten;
    return written === 1;
  }

  /** Periodic housekeeping: a pending share past its deadline is dead. */
  sweepExpired(): number {
    const now = this.now();
    return this.sql
      .exec(
        `UPDATE member_shares SET status = 'expired', updated_at = ?
         WHERE status = 'pending' AND expires_at < ?`,
        now,
        now,
      )
      .rowsWritten;
  }

  private activeMember(memberId: string): MemberView {
    const member = this.members
      .list()
      .find((candidate) => candidate.memberId === memberId);
    if (!member || member.status !== "active") {
      throw new MemberError(SHARE_RECIPIENT_UNKNOWN);
    }
    return member;
  }

  private nextSeq(): number {
    const row = this.sql
      .exec<{ n: number }>(`SELECT n FROM member_share_seq WHERE id = 1`)
      .toArray()[0];
    const next = (row?.n ?? 0) + 1;
    this.sql.exec(
      `INSERT INTO member_share_seq (id, n) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET n = excluded.n`,
      next,
    );
    return next;
  }

  private row(shareId: string): ShareRow | null {
    return (
      this.sql
        .exec<ShareRow>(
          `SELECT * FROM member_shares WHERE share_id = ?`,
          shareId,
        )
        .toArray()[0] ?? null
    );
  }

  private setStatus(shareId: string, status: ShareStatus, at: number): void {
    this.sql.exec(
      `UPDATE member_shares SET status = ?, updated_at = ? WHERE share_id = ?`,
      status,
      at,
      shareId,
    );
  }
}

// ---------------------------------------------------------------------------
// Text commands: `确认分享 shN` / `取消分享 shN`.
//
// No buttons exist on WeChat, so the sender's confirmation is a deterministic
// text command. Both the owner's channel path and a member's own Butler path
// parse it here, and only the recorded sender can ever match the row.
// ---------------------------------------------------------------------------

export type ShareCommand = { action: "confirm" | "cancel"; shareId: string };

// Command aliases are protocol words, not copy.
const SHARE_COMMANDS: Record<string, ShareCommand["action"]> = {
  "确认分享": "confirm", // i18n-ignore
  "取消分享": "cancel", // i18n-ignore
  confirm: "confirm",
  cancel: "cancel",
};

const SHARE_COMMAND_PATTERN = new RegExp(
  `^(${Object.keys(SHARE_COMMANDS).join("|")})` +
    `(?:[\\s]+(?:share[\\s]+)?(sh\\d+))$`,
  "i",
);

function unquoteCommand(command: string): string {
  for (const [open, close] of [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
  ] as ReadonlyArray<readonly [string, string]>) {
    if (
      command.length > open.length + close.length &&
      command.startsWith(open) &&
      command.endsWith(close)
    ) {
      return command.slice(open.length, -close.length).trim();
    }
  }
  return command;
}

/** Parses only the exact share command shape; anything else stays a message. */
export function parseShareCommand(text: string): ShareCommand | null {
  const match = SHARE_COMMAND_PATTERN.exec(unquoteCommand(text.trim()));
  if (!match) return null;
  const action = SHARE_COMMANDS[match[1]!.toLowerCase()];
  if (!action) return null;
  return { action, shareId: match[2]!.toLowerCase() };
}

/** Fixed diagnostic code to fixed sentence. Never raw error text. */
export function shareErrorText(locale: Locale, error: unknown): string {
  const code = shareErrorCode(error);
  if (code === null) return t(locale, "member.share.errors.SHARE_INTERNAL");
  const known = tryT(locale, `member.share.errors.${code}`);
  if (known !== undefined) return known;
  return t(locale, "member.error", { code });
}

const SHARE_CODES = [
  SHARE_ATTACHMENT_MISSING,
  SHARE_DIGEST_MISMATCH,
  SHARE_RECIPIENT_AMBIGUOUS,
  SHARE_RECIPIENT_UNKNOWN,
  SHARE_TOO_MANY_FILES,
  SHARE_INTERRUPTED,
  SHARE_NOT_FOUND,
  SHARE_TOO_LARGE,
  SHARE_EXPIRED,
  SHARE_INVALID,
  SHARE_EMPTY,
  MEMBER_ACCESS_DENIED,
] as const;

/**
 * The code survives the DO RPC boundary only as message text, so a plain
 * error carrying a known code is read the same way a MemberError is.
 */
function shareErrorCode(error: unknown): string | null {
  if (error instanceof MemberError) return error.code;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return SHARE_CODES.find((code) => message.includes(code)) ?? null;
}

// ---------------------------------------------------------------------------
// Model-facing tool. Available to the owner's Butler and to every member's:
// which attachments an actor may share is decided by the ACL table, not by the
// tool's audience, so there is no role in this file.
// ---------------------------------------------------------------------------

export type ShareRpc = {
  prepareShare(
    actor: Principal,
    recipientLabel: string,
    text: string,
    attachmentKeys: string[],
  ): Promise<SharePreview>;
};

export type ShareToolDeps = {
  /** Trusted server code; the model never supplies the actor. */
  resolveActor: () => Principal | Promise<Principal>;
  channel: ShareRpc;
  locale: Locale;
};

const PrepareShare = Type.Object({
  recipientLabel: Type.String(),
  text: Type.String(),
  attachmentKeys: Type.Optional(Type.Array(Type.String())),
});

function output(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

export function createShareTools(deps: ShareToolDeps): ToolRegistration[] {
  const { resolveActor, channel, locale } = deps;
  return [
    {
      name: "prepare_share",
      description:
        "Prepare sharing your own files and/or a message with the owner or another member. " +
        "Only a preview is returned: nothing is delivered until the sender confirms with 确认分享 shN.", // i18n-ignore
      parameters: PrepareShare,
      execute: async (args: {
        recipientLabel: string;
        text: string;
        attachmentKeys?: string[];
      }) => {
        try {
          const actor = await resolveActor();
          const preview = await channel.prepareShare(
            actor,
            args.recipientLabel,
            args.text,
            args.attachmentKeys ?? [],
          );
          const files =
            preview.files.length === 0
              ? t(locale, "member.share.noFiles")
              : preview.files.map((key) => artifactNameFromKey(key)).join("、");
          return output(
            t(locale, "member.share.prepared", {
              shareId: preview.shareId,
              recipient: preview.recipientLabel,
              expiresAt: new Date(preview.expiresAt).toISOString(),
              text: preview.text === "" ? t(locale, "member.share.noText") : preview.text,
              files,
            }),
          );
        } catch (error) {
          return output(shareErrorText(locale, error));
        }
      },
    },
  ];
}
