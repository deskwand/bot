/**
 * The member directory: owner, members, their WeChat connections and the
 * invitations that activate them.
 *
 * Every row here is metadata only. Credentials live in the private KV
 * namespace behind a `credential_key` pointer; nothing in this module accepts
 * or stores a token, and no method here is async (SQL work is synchronous, in
 * one turn of the event loop).
 */
import {
  MEMBER_ID_PATTERN,
  OWNER_ID,
  type Principal,
} from "./principal";
import {
  bootstrapMemberSchema,
  MEMBER_MIGRATION_PENDING,
  migrationReady,
} from "./artifact-access";

export type { ConnectionRef } from "./principal";

/** A WeChat credential that already passed the trusted parser. */
export type VerifiedBinding = {
  connectionId: string;
  credentialKey: string;
  accountId: string;
  userId: string;
  credentialHash: string;
};

export type MemberRole = "owner" | "member";
export type MemberStatus = "active" | "revoked";

export type MemberConnectionView = "unbound" | "running" | "expired" | "paused";

export type MemberView = {
  memberId: string;
  label: string;
  role: MemberRole;
  status: MemberStatus;
  epoch: number;
  /** What the owner needs to know about the member's WeChat link. */
  connectionStatus: MemberConnectionView;
};

/** A live WeChat connection. Metadata only: the token lives in the vault. */
export type ConnectionMetadata = {
  connectionId: string;
  memberId: string;
  accountId: string;
  userId: string;
  credentialHash: string;
  generation: number;
  status: "active" | "retired";
  cursor: string;
};

export type InviteKind = "new" | "rebind";
export type InviteStatus = "pending" | "consumed" | "cancelled";

export type InviteView = {
  inviteId: string;
  label: string;
  kind: InviteKind;
  status: InviteStatus;
  expiresAt: number;
  memberId: string | null;
};

/**
 * A stored invitation, metadata only. `tokenHash` is a SHA-256 digest of the
 * one-time binding token; the token itself only ever lives in the vault.
 */
export type InviteRecord = InviteView & {
  targetMemberId: string | null;
  expectedUserId: string | null;
  tokenHash: string | null;
  createdAt: number;
};

/**
 * What the owner hands over: an invite id, its deadline and the one-time link
 * whose fragment carries the raw token. The token never appears in SQL.
 */
export type MemberInviteLink = {
  inviteId: string;
  expiresAt: number;
  bindUrl: string;
};

export type CreateInviteOptions = {
  kind?: InviteKind;
  /** Rebind only: the member whose connection is being replaced. */
  targetMemberId?: string;
  /** Rebind only: the userId the replacement credential must carry. */
  expectedUserId?: string;
  ttlMs?: number;
  tokenHash?: string;
};

export const MEMBER_ACCESS_DENIED = "MEMBER_ACCESS_DENIED";
export const INVITE_NOT_FOUND = "INVITE_NOT_FOUND";
export const INVITE_EXPIRED = "INVITE_EXPIRED";
export const INVITE_CANCELLED = "INVITE_CANCELLED";
export const INVITE_CONSUMED = "INVITE_CONSUMED";
export const USER_ALREADY_BOUND = "USER_ALREADY_BOUND";
/** A second invite for the same label would orphan the first one's token. */
export const INVITE_PENDING = "INVITE_PENDING";

export class MemberError extends Error {
  public readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "MemberError";
    this.code = code;
  }
}

/** Plan: an invite stays valid for 15 minutes. */
const DEFAULT_INVITE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LABEL = "member";

type MemberRow = {
  id: string;
  label: string;
  role: string;
  status: string;
  epoch: number;
};

type ConnectionRow = {
  id: string;
  member_id: string;
  account_id: string;
  user_id: string;
  credential_key: string;
  credentials_hash: string;
  generation: number;
  status: string;
  cursor: string;
  poll_status: string;
};

type InviteRow = {
  id: string;
  label: string;
  kind: string;
  target_member_id: string | null;
  expected_user_id: string | null;
  status: string;
  expires_at: number;
  member_id: string | null;
  token_hash: string | null;
  created_at: number;
};

function newMemberId(): string {
  const id = `m${crypto.randomUUID().replace(/-/g, "")}`;
  if (!MEMBER_ID_PATTERN.test(id)) {
    throw new MemberError("MEMBER_ID_INVALID");
  }
  return id;
}

function viewOf(row: MemberRow, connection: ConnectionRow | null): MemberView {
  return {
    memberId: row.id,
    label: row.label,
    role: row.role === "owner" ? "owner" : "member",
    status: row.status === "revoked" ? "revoked" : "active",
    epoch: row.epoch,
    connectionStatus:
      connection === null || connection.credential_key === ""
        ? "unbound"
        : connection.poll_status === "paused"
          ? "paused"
          : connection.poll_status === "expired"
            ? "expired"
            : "running",
  };
}

function inviteRecord(row: InviteRow): InviteRecord {
  return {
    inviteId: row.id,
    label: row.label,
    kind: row.kind === "rebind" ? "rebind" : "new",
    status:
      row.status === "consumed"
        ? "consumed"
        : row.status === "cancelled"
          ? "cancelled"
          : "pending",
    expiresAt: row.expires_at,
    memberId: row.member_id,
    targetMemberId: row.target_member_id,
    expectedUserId: row.expected_user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
  };
}

function connectionView(row: ConnectionRow): ConnectionMetadata {
  return {
    connectionId: row.id,
    memberId: row.member_id,
    accountId: row.account_id,
    userId: row.user_id,
    credentialHash: row.credentials_hash,
    generation: row.generation,
    status: row.status === "retired" ? "retired" : "active",
    cursor: row.cursor,
  };
}

export class MemberStore {
  private readonly sql: SqlStorage;

  private readonly now: () => number;

  private readonly transactionSync: (<T>(fn: () => T) => T) | null;

  /**
   * `transactionSync` is the Durable Object storage transaction. Every
   * directory mutation that spans more than one statement runs inside it, so a
   * thrown SQL write rolls the whole operation back instead of leaving a
   * member without a connection or an active pointer with a pending invite.
   */
  constructor(
    sql: SqlStorage,
    now: () => number = () => Date.now(),
    transactionSync?: <T>(fn: () => T) => T,
  ) {
    this.sql = sql;
    this.now = now;
    this.transactionSync = transactionSync ?? null;
    // Provenance must be read before the members tables exist: their absence
    // is what tells a legacy single-owner database from a fresh one.
    bootstrapMemberSchema(this.sql, this.now);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 1
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS member_connections (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        credential_key TEXT NOT NULL,
        credentials_hash TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        cursor TEXT NOT NULL DEFAULT ''
      )`,
    );
    this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS current_wechat_account
        ON member_connections(account_id) WHERE status <> 'retired'`,
    );
    this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS current_wechat_user
        ON member_connections(user_id) WHERE status <> 'retired'`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS member_invites (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_member_id TEXT,
        expected_user_id TEXT,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        member_id TEXT,
        token_hash TEXT,
        created_at INTEGER NOT NULL
      )`,
    );
  }

  /**
   * The legacy owner row exists whether or not any channel credential does.
   * It grants nothing by itself: Telegram and desktop ingress still run the
   * old owner gate before they read this row.
   */
  ensureOwner(): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO members (id, label, role, status, epoch)
       VALUES (?, ?, 'owner', 'active', 1)`,
      OWNER_ID,
      OWNER_ID,
    );
  }

  /** Liveness gate for any Principal built by trusted code. */
  assertActive(actor: Principal): void {
    const row = this.memberRow(actor.memberId);
    if (!row) throw new MemberError(MEMBER_ACCESS_DENIED);
    if (row.status !== "active") throw new MemberError(MEMBER_ACCESS_DENIED);
    if (row.role !== actor.role) throw new MemberError(MEMBER_ACCESS_DENIED);
    if (row.epoch !== actor.epoch) throw new MemberError(MEMBER_ACCESS_DENIED);
  }

  /** Every invite row, for owner sweeps. Contains no raw token, only its hash. */
  listInvites(): InviteRecord[] {
    return this.sql
      .exec<InviteRow>(`SELECT * FROM member_invites ORDER BY created_at DESC`)
      .toArray()
      .map((row) => inviteRecord(row));
  }

  list(): MemberView[] {
    return this.sql
      .exec<MemberRow>(
        `SELECT id, label, role, status, epoch FROM members
         ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, id`,
      )
      .toArray()
      .map((row) => viewOf(row, this.connectionRow(row.id)));
  }

  principal(memberId: string): Principal | null {
    const row = this.memberRow(memberId);
    if (!row) return null;
    return {
      memberId: row.id,
      role: row.role === "owner" ? "owner" : "member",
      epoch: row.epoch,
    };
  }

  createInvite(label: string, options: CreateInviteOptions = {}): InviteView {
    this.ensureOwner();
    const kind: InviteKind = options.kind ?? "new";
    let targetMemberId: string | null = null;
    let expectedUserId: string | null = null;
    if (kind === "rebind") {
      targetMemberId = options.targetMemberId ?? null;
      const target = targetMemberId ? this.memberRow(targetMemberId) : null;
      if (!target || target.role !== "member") {
        throw new MemberError(MEMBER_ACCESS_DENIED);
      }
      const current = this.connectionRow(target.id);
      if (!current) throw new MemberError(MEMBER_ACCESS_DENIED);
      // The expected identity is whatever the target's current connection
      // carries. A caller-supplied value may confirm it, never replace it.
      if (
        options.expectedUserId !== undefined &&
        options.expectedUserId !== current.user_id
      ) {
        throw new MemberError(MEMBER_ACCESS_DENIED);
      }
      expectedUserId = current.user_id;
    }
    if (kind === "new") {
      // This method is synchronous, so check-and-insert cannot interleave:
      // a second invite for the same label is refused, never orphaned.
      const clash = this.sql
        .exec<{ id: string }>(
          `SELECT id FROM member_invites
            WHERE kind = 'new' AND label = ? AND status = 'pending' AND expires_at > ?`,
          label || DEFAULT_LABEL,
          this.now(),
        )
        .toArray()[0];
      if (clash) throw new MemberError(INVITE_PENDING);
    }
    const id = crypto.randomUUID();
    const expiresAt = this.now() + (options.ttlMs ?? DEFAULT_INVITE_TTL_MS);
    this.sql.exec(
      `INSERT INTO member_invites
        (id, label, kind, target_member_id, expected_user_id, status, expires_at, member_id, token_hash, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`,
      id,
      label || DEFAULT_LABEL,
      kind,
      targetMemberId,
      expectedUserId,
      expiresAt,
      options.tokenHash ?? null,
      this.now(),
    );
    return {
      inviteId: id,
      label: label || DEFAULT_LABEL,
      kind,
      status: "pending",
      expiresAt,
      memberId: null,
    };
  }

  /** One member's stored metadata, or `null` when the id is unknown. */
  getMember(memberId: string): MemberView | null {
    const row = this.memberRow(memberId);
    return row ? viewOf(row, this.connectionRow(row.id)) : null;
  }

  /** One stored invitation, hashes and deadlines only. Never a token. */
  getInvite(inviteId: string): InviteRecord | null {
    const row = this.inviteRow(inviteId);
    return row ? inviteRecord(row) : null;
  }

  /**
   * The invitation a presented token refers to, by digest. The caller hashes
   * the token; this lookup never sees the raw value.
   */
  findInviteByTokenHash(tokenHash: string): InviteRecord | null {
    const row =
      this.sql
        .exec<InviteRow>(`SELECT * FROM member_invites WHERE token_hash = ?`, tokenHash)
        .toArray()[0] ?? null;
    return row ? inviteRecord(row) : null;
  }

  cancelInvite(inviteId: string): void {
    this.sql.exec(
      `UPDATE member_invites SET status = 'cancelled'
       WHERE id = ? AND status = 'pending'`,
      inviteId,
    );
  }

  /**
   * Consumes a pending invite and activates the member in one synchronous
   * step. The credential itself must already be saved by the caller; this
   * method only records the pointer, so a failed activation can delete the
   * candidate key without ever touching a live one.
   */
  completeInvite(inviteId: string, binding: VerifiedBinding): MemberView {
    return this.tx(() => this.runCompleteInvite(inviteId, binding));
  }

  private runCompleteInvite(
    inviteId: string,
    binding: VerifiedBinding,
  ): MemberView {
    const invite = this.inviteRow(inviteId);
    if (!invite) throw new MemberError(INVITE_NOT_FOUND);
    if (invite.status === "cancelled") throw new MemberError(INVITE_CANCELLED);
    if (invite.status === "consumed") {
      if (
        invite.member_id &&
        this.connectionRow(invite.member_id)?.credential_key ===
          binding.credentialKey
      ) {
        return viewOf(this.memberRow(invite.member_id)!, this.connectionRow(invite.member_id));
      }
      throw new MemberError(INVITE_CONSUMED);
    }
    if (this.now() >= invite.expires_at) {
      throw new MemberError(INVITE_EXPIRED);
    }
    this.ensureOwner();
    // No member exists before the legacy inbox decision is settled: an
    // activation during (or after a failed) backfill would invalidate the
    // single-owner assumption the backfill relies on.
    this.assertActivationReady();

    const holder = this.connectionByAccountOrUser(
      binding.accountId,
      binding.userId,
    );
    const targetId =
      invite.kind === "rebind" ? invite.target_member_id : null;

    if (targetId) {
      const target = this.memberRow(targetId);
      if (!target || target.role !== "member" || target.status !== "active") {
        throw new MemberError(MEMBER_ACCESS_DENIED);
      }
      // The stored connection is the authority on who this member is; the
      // invite row only records what it was when the invite was created.
      const current = this.connectionRow(targetId);
      if (!current) throw new MemberError(MEMBER_ACCESS_DENIED);
      if (current.user_id !== binding.userId) {
        throw new MemberError(MEMBER_ACCESS_DENIED);
      }
      if (
        invite.expected_user_id !== null &&
        invite.expected_user_id !== current.user_id
      ) {
        throw new MemberError(MEMBER_ACCESS_DENIED);
      }
      if (holder && holder.member_id !== targetId) {
        throw new MemberError(USER_ALREADY_BOUND);
      }
      const generation = current.generation + 1;
      this.sql.exec(
        `UPDATE member_connections
         SET id = ?, account_id = ?, user_id = ?, credential_key = ?,
             credentials_hash = ?, generation = ?, status = 'active'
         WHERE member_id = ?`,
        binding.connectionId,
        binding.accountId,
        binding.userId,
        binding.credentialKey,
        binding.credentialHash,
        generation,
        targetId,
      );
      this.consumeInvite(inviteId, targetId);
      return viewOf(target, this.connectionRow(target.id));
    }

    if (holder) throw new MemberError(USER_ALREADY_BOUND);

    const memberId = newMemberId();
    this.sql.exec(
      `INSERT INTO members (id, label, role, status, epoch)
       VALUES (?, ?, 'member', 'active', 1)`,
      memberId,
      invite.label,
    );
    this.sql.exec(
      `INSERT INTO member_connections
        (id, member_id, account_id, user_id, credential_key, credentials_hash, generation, status, cursor)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'active', '')`,
      binding.connectionId,
      memberId,
      binding.accountId,
      binding.userId,
      binding.credentialKey,
      binding.credentialHash,
    );
    this.consumeInvite(inviteId, memberId);
    return viewOf(this.memberRow(memberId)!, this.connectionRow(memberId));
  }

  /** Live connection's credential hash, for trusted idempotency checks. */
  credentialHashOf(memberId: string): string | null {
    return this.connectionRow(memberId)?.credentials_hash ?? null;
  }

  /** Live connection's credential key pointer, for trusted cleanup. */
  credentialKeyOf(memberId: string): string | null {
    return this.connectionRow(memberId)?.credential_key ?? null;
  }

  /**
   * Typed metadata of a member's live connection. A retired or missing
   * connection is `null`; no token, only the pointer-free public fields.
   */
  getConnection(memberId: string): ConnectionMetadata | null {
    const row = this.connectionRow(memberId);
    return row ? connectionView(row) : null;
  }

  /** Every live connection, owner first, then by member id. */
  listConnections(): ConnectionMetadata[] {
    return this.sql
      .exec<ConnectionRow>(
        `SELECT * FROM member_connections WHERE status <> 'retired'
         ORDER BY CASE WHEN member_id = ? THEN 0 ELSE 1 END, member_id`,
        OWNER_ID,
      )
      .toArray()
      .map(connectionView);
  }

  /**
   * Revoking bumps the epoch so every Principal handed out before this point
   * fails `assertActive`. The owner row is never revocable here.
   */
  revoke(memberId: string): void {
    if (memberId === OWNER_ID) throw new MemberError(MEMBER_ACCESS_DENIED);
    const row = this.memberRow(memberId);
    if (!row) throw new MemberError(MEMBER_ACCESS_DENIED);
    this.sql.exec(
      `UPDATE members SET status = 'revoked', epoch = epoch + 1 WHERE id = ?`,
      memberId,
    );
    this.sql.exec(
      `UPDATE member_connections SET status = 'retired' WHERE member_id = ?`,
      memberId,
    );
  }

  /**
   * Idempotent legacy owner import. A new credential key advances the
   * generation; the same key changes nothing. A userId already owned by a
   * member refuses the import instead of transferring data.
   */
  importOwner(binding: VerifiedBinding): void {
    this.tx(() => this.runImportOwner(binding));
  }

  private runImportOwner(binding: VerifiedBinding): void {
    this.ensureOwner();
    const conflict = this.sql
      .exec<{ member_id: string }>(
        `SELECT member_id FROM member_connections
         WHERE status <> 'retired' AND member_id <> ?
           AND (account_id = ? OR user_id = ?)
         LIMIT 1`,
        OWNER_ID,
        binding.accountId,
        binding.userId,
      )
      .toArray();
    if (conflict.length > 0) throw new MemberError(MEMBER_ACCESS_DENIED);

    const current = this.connectionRow(OWNER_ID);
    if (!current) {
      this.sql.exec(
        `INSERT INTO member_connections
          (id, member_id, account_id, user_id, credential_key, credentials_hash, generation, status, cursor)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'active', '')`,
        binding.connectionId,
        OWNER_ID,
        binding.accountId,
        binding.userId,
        binding.credentialKey,
        binding.credentialHash,
      );
      return;
    }
    if (current.credential_key === binding.credentialKey) return;
    this.sql.exec(
      `UPDATE member_connections
       SET id = ?, account_id = ?, user_id = ?, credential_key = ?,
           credentials_hash = ?, generation = generation + 1, status = 'active'
       WHERE member_id = ?`,
      binding.connectionId,
      binding.accountId,
      binding.userId,
      binding.credentialKey,
      binding.credentialHash,
      OWNER_ID,
    );
  }

  private tx<T>(fn: () => T): T {
    return this.transactionSync ? this.transactionSync(fn) : fn();
  }

  /** Member activation waits for the legacy inbox decision to be settled. */
  private assertActivationReady(): void {
    if (!migrationReady(this.sql)) {
      throw new MemberError(MEMBER_MIGRATION_PENDING);
    }
  }

  private consumeInvite(inviteId: string, memberId: string): void {
    this.sql.exec(
      `UPDATE member_invites SET status = 'consumed', member_id = ?
       WHERE id = ? AND status = 'pending'`,
      memberId,
      inviteId,
    );
  }

  private memberRow(memberId: string): MemberRow | null {
    return (
      this.sql
        .exec<MemberRow>(
          `SELECT id, label, role, status, epoch FROM members WHERE id = ?`,
          memberId,
        )
        .toArray()[0] ?? null
    );
  }

  private connectionRow(memberId: string): ConnectionRow | null {
    return (
      this.sql
        .exec<ConnectionRow>(
          `SELECT * FROM member_connections
           WHERE member_id = ? AND status <> 'retired'`,
          memberId,
        )
        .toArray()[0] ?? null
    );
  }

  private connectionByAccountOrUser(
    accountId: string,
    userId: string,
  ): ConnectionRow | null {
    return (
      this.sql
        .exec<ConnectionRow>(
          `SELECT * FROM member_connections
           WHERE status <> 'retired' AND (account_id = ? OR user_id = ?)
           LIMIT 1`,
          accountId,
          userId,
        )
        .toArray()[0] ?? null
    );
  }

  private inviteRow(inviteId: string): InviteRow | null {
    return (
      this.sql
        .exec<InviteRow>(`SELECT * FROM member_invites WHERE id = ?`, inviteId)
        .toArray()[0] ?? null
    );
  }
}
