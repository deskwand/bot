import type { Hex } from "viem";
import type { Token } from "./chain";
import { REMIT_STALE_MS } from "./guard";

const HOUR_MS = 3_600_000;

/** Tokens whose price is sampled every hour. */
const PRICED_TOKENS = ["WETH", "cbBTC"] as const;

export type RemittanceStatus = "pending" | "confirmed" | "failed";
export type TradeStatus = "pending" | "confirmed" | "failed";

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

export type TradeRow = {
  id: string;
  at: number;
  sell: string;
  buy: string;
  amount_in: string;
  min_out: string;
  value_before: number;
  value_after: number | null;
  tx_hash: Hex | null;
  nonce: number | null;
  raw: Hex | null;
  status: TradeStatus;
  error: string | null;
};

export type JournalTable = "remittances" | "trades";

export type PricePoint = { at: number; usd: number };

export type PriceSeries = { token: Token; points: PricePoint[] };

/** The part of a pending row both ledgers share. */
export type JournalRow = {
  table: JournalTable;
  id: string;
  at: number;
  tx_hash: Hex | null;
  nonce: number | null;
  raw: Hex | null;
};

/**
 * The remittance and swap journals. A row is written before signing so every
 * signed transaction has a home, even if the Worker dies before it hears back.
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
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        sell TEXT NOT NULL,
        buy TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        min_out TEXT NOT NULL,
        value_before REAL NOT NULL,
        value_after REAL,
        tx_hash TEXT,
        nonce INTEGER,
        raw TEXT,
        status TEXT NOT NULL,
        error TEXT
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS prices (
        hour INTEGER NOT NULL,
        token TEXT NOT NULL,
        usd REAL NOT NULL,
        PRIMARY KEY (hour, token)
      )`,
    );
  }

  /** False after a restore that began with an empty schema. */
  hasTable(table: string = "remittances"): boolean {
    const row = this.sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
        table,
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

  insertTrade(
    id: string,
    at: number,
    sell: string,
    buy: string,
    amountIn: bigint,
    minOut: bigint,
    valueBefore: number,
  ): void {
    this.sql.exec(
      `INSERT INTO trades
        (id, at, sell, buy, amount_in, min_out, value_before, value_after,
         tx_hash, nonce, raw, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'pending', NULL)`,
      id,
      at,
      sell,
      buy,
      amountIn.toString(),
      minOut.toString(),
      valueBefore,
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

  setTradeHash(id: string, hash: Hex, nonce: number, raw: Hex): void {
    this.sql.exec(
      `UPDATE trades SET tx_hash = ?, nonce = ?, raw = ?
       WHERE id = ? AND status = 'pending'`,
      hash,
      nonce,
      raw,
      id,
    );
  }

  markConfirmed(table: JournalTable, id: string): void {
    this.sql.exec(
      `UPDATE ${table} SET status = 'confirmed', error = NULL WHERE id = ?`,
      id,
    );
  }

  markFailed(
    table: JournalTable,
    id: string,
    error: string | null,
  ): void {
    this.sql.exec(
      `UPDATE ${table} SET status = 'failed', error = ? WHERE id = ?`,
      error,
      id,
    );
  }

  setTradeValueAfter(id: string, valueAfter: number): void {
    this.sql.exec(
      `UPDATE trades SET value_after = ?
       WHERE id = ? AND status = 'confirmed' AND value_after IS NULL`,
      valueAfter,
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
    if (!this.hasTable("remittances")) return [];
    return this.sql
      .exec<RemittanceRow>(
        `SELECT id, at, usdc, reason, tx_hash, nonce, raw, status, settled_at, error
         FROM remittances WHERE status = 'pending' ORDER BY rowid`,
      )
      .toArray();
  }

  /** Every pending row in either journal, oldest first. */
  pendingAll(): JournalRow[] {
    const rows: JournalRow[] = [];
    if (this.hasTable("remittances")) {
      rows.push(
        ...this.sql
          .exec<JournalRow>(
            `SELECT 'remittances' AS "table", id, at, tx_hash, nonce, raw
             FROM remittances WHERE status = 'pending'`,
          )
          .toArray(),
      );
    }
    if (this.hasTable("trades")) {
      rows.push(
        ...this.sql
          .exec<JournalRow>(
            `SELECT 'trades' AS "table", id, at, tx_hash, nonce, raw
             FROM trades WHERE status = 'pending'`,
          )
          .toArray(),
      );
    }
    return rows.sort((a, b) =>
      a.at !== b.at
        ? a.at - b.at
        : a.table !== b.table
          ? a.table.localeCompare(b.table)
          : a.id.localeCompare(b.id),
    );
  }

  /**
   * Everything the owner might still be waiting for: all pending rows, plus
   * confirmed rows that were never settled and are not stale yet.
   */
  pendingRemittance(now: number): RemittanceRow | undefined {
    if (!this.hasTable("remittances")) return undefined;
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
    if (!this.hasTable("remittances")) return undefined;
    return this.sql
      .exec<RemittanceRow>(
        `SELECT id, at, usdc, reason, tx_hash, nonce, raw, status, settled_at, error
         FROM remittances WHERE id = ?`,
        id,
      )
      .toArray()[0];
  }

  /** Trades that count toward the breaker window. */
  confirmedTrades(since: number): TradeRow[] {
    if (!this.hasTable("trades")) return [];
    return this.sql
      .exec<TradeRow>(
        `SELECT id, at, sell, buy, amount_in, min_out, value_before,
                value_after, tx_hash, nonce, raw, status, error
         FROM trades WHERE status = 'confirmed' AND at >= ? ORDER BY at`,
        since,
      )
      .toArray();
  }

  recentRemittances(limit: number): RemittanceRow[] {
    if (!this.hasTable("remittances")) return [];
    return this.sql
      .exec<RemittanceRow>(
        `SELECT id, at, usdc, reason, tx_hash, nonce, raw, status, settled_at, error
         FROM remittances ORDER BY at DESC, rowid DESC LIMIT ?`,
        limit,
      )
      .toArray();
  }

  recentTrades(limit: number): TradeRow[] {
    if (!this.hasTable("trades")) return [];
    return this.sql
      .exec<TradeRow>(
        `SELECT id, at, sell, buy, amount_in, min_out, value_before,
                value_after, tx_hash, nonce, raw, status, error
         FROM trades ORDER BY at DESC, rowid DESC LIMIT ?`,
        limit,
      )
      .toArray();
  }

  /** Stores one hourly sample, replacing an earlier one for the same hour. */
  insertPrice(hour: number, token: Token, usd: number): void {
    if (!this.hasTable("prices")) return;
    this.sql.exec(
      `INSERT INTO prices (hour, token, usd) VALUES (?, ?, ?)
       ON CONFLICT(hour, token) DO UPDATE SET usd = excluded.usd`,
      hour,
      token,
      usd,
    );
  }

  deletePricesBefore(hour: number): void {
    if (!this.hasTable("prices")) return;
    this.sql.exec(`DELETE FROM prices WHERE hour < ?`, hour);
  }

  /** WETH and cbBTC series, each oldest first. */
  priceSeries(sinceHour: number): PriceSeries[] {
    const points: Record<(typeof PRICED_TOKENS)[number], PricePoint[]> = {
      WETH: [],
      cbBTC: [],
    };
    if (this.hasTable("prices")) {
      const rows = this.sql
        .exec<{ hour: number; token: string; usd: number }>(
          `SELECT hour, token, usd FROM prices
           WHERE token IN ('WETH', 'cbBTC') AND hour >= ?
           ORDER BY token, hour`,
          sinceHour,
        )
        .toArray();
      for (const row of rows) {
        if (row.token !== "WETH" && row.token !== "cbBTC") continue;
        points[row.token].push({ at: row.hour * HOUR_MS, usd: row.usd });
      }
    }
    return PRICED_TOKENS.map((token) => ({ token, points: points[token] }));
  }
}
