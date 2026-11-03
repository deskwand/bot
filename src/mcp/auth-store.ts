import type { OAuthClient, OAuthTokens } from "./oauth";

/** A completed authorization is only valid for ten minutes. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

export type ClientRow = {
  name: string;
  url: string;
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  registeredAt: number;
};

export type TokenRow = {
  name: string;
  url: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scope: string | null;
  state: "ok" | "needs_reauth";
  notified: boolean;
};

export type PendingRow = {
  state: string;
  name: string;
  verifier: string;
  createdAt: number;
};

type ClientDbRow = {
  name: string;
  url: string;
  issuer: string;
  client_id: string;
  client_secret: string | null;
  registered_at: number;
};

type TokenDbRow = {
  name: string;
  url: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  scope: string | null;
  state: "ok" | "needs_reauth";
  notified: number;
};

type PendingDbRow = {
  state: string;
  name: string;
  verifier: string;
  created_at: number;
};

/**
 * The three tables `McpAuthDO` keeps: one DCR client and one token set per
 * server name, plus short-lived pending authorization states.
 *
 * Clients and tokens store the configured `url` verbatim (placeholders not
 * resolved). Reads compare it with the current config, so editing a server's
 * URL invalidates the old registration and token instead of sending them to a
 * different address.
 */
export class McpAuthStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS clients (
        name TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        issuer TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_secret TEXT,
        registered_at INTEGER NOT NULL
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS tokens (
        name TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER,
        scope TEXT,
        state TEXT NOT NULL,
        notified INTEGER NOT NULL DEFAULT 0
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS pending (
        state TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        verifier TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
  }

  getClient(name: string, url: string): ClientRow | null {
    const row = this.sql
      .exec<ClientDbRow>(
        `SELECT name, url, issuer, client_id, client_secret, registered_at
         FROM clients WHERE name = ?`,
        name,
      )
      .toArray()[0];
    if (!row || row.url !== url) return null;

    return {
      name: row.name,
      url: row.url,
      issuer: row.issuer,
      clientId: row.client_id,
      clientSecret: row.client_secret ?? undefined,
      registeredAt: row.registered_at,
    };
  }

  saveClient(
    name: string,
    url: string,
    client: OAuthClient,
    registeredAt: number,
  ): void {
    this.sql.exec(
      `INSERT INTO clients (name, url, issuer, client_id, client_secret, registered_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         url = excluded.url,
         issuer = excluded.issuer,
         client_id = excluded.client_id,
         client_secret = excluded.client_secret,
         registered_at = excluded.registered_at`,
      name,
      url,
      client.issuer,
      client.clientId,
      client.clientSecret ?? null,
      registeredAt,
    );
  }

  getTokens(name: string, url: string): TokenRow | null {
    const row = this.sql
      .exec<TokenDbRow>(
        `SELECT name, url, access_token, refresh_token, expires_at, scope,
                state, notified
         FROM tokens WHERE name = ?`,
        name,
      )
      .toArray()[0];
    if (!row || row.url !== url) return null;

    return {
      name: row.name,
      url: row.url,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      scope: row.scope,
      state: row.state,
      notified: row.notified !== 0,
    };
  }

  saveTokens(name: string, url: string, tokens: OAuthTokens): void {
    this.sql.exec(
      `INSERT INTO tokens
         (name, url, access_token, refresh_token, expires_at, scope, state, notified)
       VALUES (?, ?, ?, ?, ?, ?, 'ok', 0)
       ON CONFLICT(name) DO UPDATE SET
         url = excluded.url,
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         scope = excluded.scope,
         state = 'ok',
         notified = 0`,
      name,
      url,
      tokens.accessToken,
      tokens.refreshToken ?? null,
      tokens.expiresAt,
      tokens.scope ?? null,
    );
  }

  markNeedsReauth(name: string): void {
    this.sql.exec(
      `UPDATE tokens SET state = 'needs_reauth' WHERE name = ?`,
      name,
    );
  }

  /** Claims the single "authorization expired" notice for this token set. */
  takeNotice(name: string): boolean {
    return (
      this.sql.exec(
        `UPDATE tokens SET notified = 1 WHERE name = ? AND notified = 0`,
        name,
      ).rowsWritten > 0
    );
  }

  deleteClient(name: string): void {
    this.sql.exec(`DELETE FROM clients WHERE name = ?`, name);
  }

  deleteTokens(name: string): void {
    this.sql.exec(`DELETE FROM tokens WHERE name = ?`, name);
  }

  putPending(
    state: string,
    name: string,
    verifier: string,
    createdAt: number,
  ): void {
    this.sql.exec(
      `DELETE FROM pending WHERE created_at <= ?`,
      createdAt - PENDING_TTL_MS,
    );
    this.sql.exec(
      `INSERT OR REPLACE INTO pending (state, name, verifier, created_at)
       VALUES (?, ?, ?, ?)`,
      state,
      name,
      verifier,
      createdAt,
    );
  }

  /** Removes and returns a pending state; expired or missing states are null. */
  takePending(state: string, now: number): PendingRow | null {
    const row = this.sql
      .exec<PendingDbRow>(
        `SELECT state, name, verifier, created_at FROM pending WHERE state = ?`,
        state,
      )
      .toArray()[0];
    if (!row) return null;

    this.sql.exec(`DELETE FROM pending WHERE state = ?`, state);
    if (row.created_at + PENDING_TTL_MS <= now) return null;

    return {
      state: row.state,
      name: row.name,
      verifier: row.verifier,
      createdAt: row.created_at,
    };
  }

  deletePendingFor(name: string): void {
    this.sql.exec(`DELETE FROM pending WHERE name = ?`, name);
  }
}
