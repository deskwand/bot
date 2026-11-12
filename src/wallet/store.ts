import type { Hex } from "viem";
import { REMIT_STALE_MS } from "./guard";

export type RemittanceStatus = "pending" | "confirmed" | "failed";

export type RemittanceRow = {
  id: string;
  at: number;
  usdc: string;
  reason: string;
  tx_hash: Hex | null;
  nonce: number | null;
  raw: Hex | null;
  status: RemittanceStatus;
  settled_at: number | null;
  error: string | null;
};

/**
 * The remittance journal. A row is written before signing so every signed
 * transaction has a home, even if the Worker dies before it hears back.
 */
export class WalletStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS remittances (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        usdc TEXT NOT NULL,
        reason TEXT NOT NULL,
        tx_hash TEXT,
        nonce INTEGER,
        raw TEXT,
        status TEXT NOT NULL,
        settled_at INTEGER,
        error TEXT
      )`,
    );
  }

  /** False after a restore that began with an empty schema. */
  hasTable(): boolean {
    const row = this.sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM sqlite_master
         WHERE type = 'table' AND name = 'remittances'`,
      )
      .toArray()[0];
    return (row?.n ?? 0) > 0;
  }

  insertPending(id: string, at: number, usdc: bigint, reason: string): void {
    this.sql.exec(
      `INSERT INTO remittances
        (id, at, usdc, reason, tx_hash, status, settled_at, error)
       VALUES (?, ?, ?, ?, NULL, 'pending', NULL, NULL)`,
      id,
      at,
      usdc.toString(),
      reason,
    );
  }

  setHash(id: string, hash: Hex, nonce: number, raw: Hex): void {
    this.sql.exec(
      `UPDATE remittances SET tx_hash = ?, nonce = ?, raw = ?
       WHERE id = ? AND status = 'pending'`,
      hash,
      nonce,
      raw,
      id,
    );
  }

  markConfirmed(id: string): void {
    this.sql.exec(
      `UPDATE remittances SET status = 'confirmed', error = NULL WHERE id = ?`,
      id,
    );
  }

  markFailed(id: string, error: string | null): void {
    this.sql.exec(
      `UPDATE remittances SET status = 'failed', error = ? WHERE id = ?`,
      error,
      id,
    );
  }

  markSettled(id: string, at: number): void {
    this.sql.exec(
      `UPDATE remittances SET settled_at = ? WHERE id = ? AND status = 'confirmed'`,
      at,
      id,
    );
  }

  pending(): RemittanceRow[] {
    return this.sql
      .exec<RemittanceRow>(
        `SELECT id, at, usdc, reason, tx_hash, nonce, raw, status, settled_at, error
         FROM remittances WHERE status = 'pending' ORDER BY rowid`,
      )
      .toArray();
  }

  /**
   * Everything the owner might still be waiting for: all pending rows, plus
   * confirmed rows that were never settled and are not stale yet.
   */
  pendingRemittance(now: number): RemittanceRow | undefined {
    return this.sql
      .exec<RemittanceRow>(
        `SELECT id, at, usdc, reason, tx_hash, nonce, raw, status, settled_at, error
         FROM remittances
         WHERE status = 'pending'
            OR (status = 'confirmed'
                AND settled_at IS NULL
                AND ? - at <= ?)
         ORDER BY at ASC LIMIT 1`,
        now,
        REMIT_STALE_MS,
      )
      .toArray()[0];
  }

  get(id: string): RemittanceRow | undefined {
    return this.sql
      .exec<RemittanceRow>(
        `SELECT id, at, usdc, reason, tx_hash, nonce, raw, status, settled_at, error
         FROM remittances WHERE id = ?`,
        id,
      )
      .toArray()[0];
  }
}
