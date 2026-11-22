/**
 * Per-connection WeChat runtime state.
 *
 * The directory (`member_connections`) owns identity: member, account, userId,
 * credential pointer, generation. This module adds the mutable runtime columns
 * a poller needs — conversation address, poll status, poll clock, expiry
 * notice — and keeps the context token in the private vault, never in SQL.
 *
 * Every write is keyed by connection id and, when the caller knows it, by the
 * generation: a callback from a replaced credential can neither read nor
 * overwrite the state of its successor.
 */
export type ConnectionStatus = "active" | "retired";
export type PollStatus = "idle" | "polling" | "expired" | "paused" | "needs_reset";

export type ConnectionState = {
  connectionId: string;
  memberId: string;
  accountId: string;
  userId: string;
  generation: number;
  status: ConnectionStatus;
  conversationId: string;
  pollStatus: PollStatus;
  lastPollAt: number | null;
  expiryNotified: boolean;
};

/** The only columns `update` may write. */
export type ConnectionPatch = {
  conversationId?: string;
  pollStatus?: PollStatus;
  lastPollAt?: number | null;
  expiryNotified?: boolean;
};

/**
 * The slice of the private vault this module needs. `CredentialVault` satisfies
 * it structurally; tests use a map.
 */
export type ContextVault = {
  get(key: string): Promise<unknown>;
  put(key: string, value: string): Promise<unknown>;
};

export const CONNECTION_VAULT_MISSING = "CONNECTION_VAULT_MISSING";
export const CONNECTION_POLL_STATUS_INVALID = "CONNECTION_POLL_STATUS_INVALID";

const POLL_STATUSES: readonly PollStatus[] = [
  "idle",
  "polling",
  "expired",
  "paused",
  // The send retry budget is spent: the channel needs an operator (restart or
  // rebind) before it can drain again.
  "needs_reset",
];

/** Vault key of one connection's context token, scoped by generation. */
export function contextKey(connectionId: string, generation: number): string {
  return `connection:${connectionId}:${generation}:context`;
}

type Row = {
  id: string;
  member_id: string;
  account_id: string;
  user_id: string;
  generation: number;
  status: string;
  conversation_id: string;
  poll_status: string;
  last_poll_at: number | null;
  expiry_notified: number;
};

function stateOf(row: Row): ConnectionState {
  return {
    connectionId: row.id,
    memberId: row.member_id,
    accountId: row.account_id,
    userId: row.user_id,
    generation: row.generation,
    status: row.status === "retired" ? "retired" : "active",
    conversationId: row.conversation_id,
    pollStatus: POLL_STATUSES.includes(row.poll_status as PollStatus)
      ? (row.poll_status as PollStatus)
      : "idle",
    lastPollAt: row.last_poll_at,
    expiryNotified: row.expiry_notified === 1,
  };
}

export class ConnectionStore {
  private readonly sql: SqlStorage;

  private readonly vault: ContextVault | null;

  constructor(sql: SqlStorage, vault: ContextVault | null = null) {
    this.sql = sql;
    this.vault = vault;
    // Mirrors the directory's table. In production `MemberStore` runs first
    // and records provenance; this `IF NOT EXISTS` only covers a fresh store
    // where no connection row was ever written.
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
        cursor TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        poll_status TEXT NOT NULL DEFAULT 'idle',
        last_poll_at INTEGER,
        expiry_notified INTEGER NOT NULL DEFAULT 0
      )`,
    );

    // A directory created before this module has none of the runtime columns.
    const columns = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(member_connections)`)
      .toArray();
    const has = (name: string) => columns.some((entry) => entry.name === name);
    if (!has("conversation_id")) {
      this.sql.exec(
        `ALTER TABLE member_connections
         ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''`,
      );
    }
    if (!has("poll_status")) {
      this.sql.exec(
        `ALTER TABLE member_connections
         ADD COLUMN poll_status TEXT NOT NULL DEFAULT 'idle'`,
      );
    }
    if (!has("last_poll_at")) {
      this.sql.exec(
        `ALTER TABLE member_connections ADD COLUMN last_poll_at INTEGER`,
      );
    }
    if (!has("expiry_notified")) {
      this.sql.exec(
        `ALTER TABLE member_connections
         ADD COLUMN expiry_notified INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }

  read(connectionId: string): ConnectionState | null {
    const row = this.sql
      .exec<Row>(`SELECT * FROM member_connections WHERE id = ?`, connectionId)
      .toArray()[0];
    return row ? stateOf(row) : null;
  }

  listActive(): ConnectionState[] {
    return this.sql
      .exec<Row>(
        `SELECT * FROM member_connections WHERE status = 'active'
         ORDER BY member_id`,
      )
      .toArray()
      .map(stateOf);
  }

  /**
   * Writes the whitelisted columns. With `expectedGeneration` the write only
   * happens while that generation is the live one, so a stale callback cannot
   * mutate its successor. Returns whether a row was written.
   */
  update(
    connectionId: string,
    patch: ConnectionPatch,
    expectedGeneration?: number,
  ): boolean {
    const assignments: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.conversationId !== undefined) {
      assignments.push("conversation_id = ?");
      values.push(patch.conversationId);
    }
    if (patch.pollStatus !== undefined) {
      if (!POLL_STATUSES.includes(patch.pollStatus)) {
        throw new Error(CONNECTION_POLL_STATUS_INVALID);
      }
      assignments.push("poll_status = ?");
      values.push(patch.pollStatus);
    }
    if (patch.lastPollAt !== undefined) {
      assignments.push("last_poll_at = ?");
      values.push(patch.lastPollAt);
    }
    if (patch.expiryNotified !== undefined) {
      assignments.push("expiry_notified = ?");
      values.push(patch.expiryNotified ? 1 : 0);
    }
    if (assignments.length === 0) return false;

    let where = "id = ? AND status <> 'retired'";
    values.push(connectionId);
    if (expectedGeneration !== undefined) {
      where += " AND generation = ?";
      values.push(expectedGeneration);
    }
    this.sql.exec(
      `UPDATE member_connections SET ${assignments.join(", ")} WHERE ${where}`,
      ...values,
    );
    return this.changed();
  }

  /** Owner-only address book keep-out: a member writes only its own row. */
  setConversation(connectionId: string, conversationId: string): boolean {
    return this.update(connectionId, { conversationId });
  }

  /** Reads the token only while `generation` is the live one. */
  async readContext(
    connectionId: string,
    generation: number,
  ): Promise<string | null> {
    const vault = this.requireVault();
    if (!this.isCurrent(connectionId, generation)) return null;
    const value = await vault.get(contextKey(connectionId, generation));
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  /** Stores the token for the live generation; a stale write is refused. */
  async writeContext(
    connectionId: string,
    generation: number,
    token: string,
  ): Promise<boolean> {
    const vault = this.requireVault();
    if (!this.isCurrent(connectionId, generation)) return false;
    await vault.put(contextKey(connectionId, generation), token);
    return true;
  }

  private isCurrent(connectionId: string, generation: number): boolean {
    const row = this.sql
      .exec<{ generation: number }>(
        `SELECT generation FROM member_connections
         WHERE id = ? AND status <> 'retired'`,
        connectionId,
      )
      .toArray()[0];
    return row !== undefined && row.generation === generation;
  }

  private requireVault(): ContextVault {
    if (this.vault === null) throw new Error(CONNECTION_VAULT_MISSING);
    return this.vault;
  }

  private changed(): boolean {
    const row = this.sql
      .exec<{ changed: number }>(`SELECT changes() AS changed`)
      .toArray()[0];
    return (row?.changed ?? 0) > 0;
  }
}
