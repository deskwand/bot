import { WINDOW_MS, type VitalsInput } from "./vitals";

export type SpendEntry = {
  callId: string;
  at: number;
  source: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
  priced: boolean;
};

export type CreditSource = "owner_topup" | "calibration";

type TotalRow = { total: number | null };
type AtRow = { at: number | null };
type SourceRow = { source: string; usd: number };

/**
 * The spend and credit ledger. Totals are summed on every read: there is no
 * running balance row, and old rows are never pruned.
 */
export class Books {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS spend (
        call_id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        source TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        usd REAL NOT NULL,
        priced INTEGER NOT NULL
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS spend_at ON spend (at)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS credit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        usd REAL NOT NULL,
        source TEXT NOT NULL,
        note TEXT NOT NULL
      )`,
    );
  }

  /** False when `callId` was already recorded. */
  recordSpend(entry: SpendEntry): boolean {
    return (
      this.sql.exec(
        `INSERT OR IGNORE INTO spend (
          call_id, at, source, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          usd, priced
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.callId,
        entry.at,
        entry.source,
        entry.provider,
        entry.model,
        entry.inputTokens,
        entry.outputTokens,
        entry.cacheReadTokens,
        entry.cacheWriteTokens,
        entry.usd,
        entry.priced ? 1 : 0,
      ).rowsWritten > 0
    );
  }

  recordCredit(
    at: number,
    usd: number,
    source: CreditSource,
    note: string,
  ): void {
    this.sql.exec(
      `INSERT INTO credit (at, usd, source, note) VALUES (?, ?, ?, ?)`,
      at,
      usd,
      source,
      note,
    );
  }

  vitalsInput(now: number): VitalsInput {
    const windowStart = now - WINDOW_MS;
    const creditTotalUsd =
      this.sql
        .exec<TotalRow>(`SELECT COALESCE(SUM(usd), 0) AS total FROM credit`)
        .toArray()[0]?.total ?? 0;
    const spendTotalUsd =
      this.sql
        .exec<TotalRow>(`SELECT COALESCE(SUM(usd), 0) AS total FROM spend`)
        .toArray()[0]?.total ?? 0;
    const spendWindowUsd =
      this.sql
        .exec<TotalRow>(
          `SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE at > ?`,
          windowStart,
        )
        .toArray()[0]?.total ?? 0;
    const firstSpendAt =
      this.sql
        .exec<AtRow>(`SELECT MIN(at) AS at FROM spend`)
        .toArray()[0]?.at ?? null;
    const hasCredit =
      this.sql.exec(`SELECT 1 FROM credit LIMIT 1`).toArray().length > 0;
    const unpriced =
      this.sql
        .exec(
          `SELECT 1 FROM spend WHERE at > ? AND priced = 0 LIMIT 1`,
          windowStart,
        )
        .toArray().length > 0;
    const topSources = this.sql
      .exec<SourceRow>(
        `SELECT source, SUM(usd) AS usd FROM spend
         WHERE at > ?
         GROUP BY source
         ORDER BY usd DESC, source ASC
         LIMIT 3`,
        windowStart,
      )
      .toArray();

    return {
      now,
      creditTotalUsd,
      spendTotalUsd,
      spendWindowUsd,
      firstSpendAt,
      hasCredit,
      unpriced,
      topSources,
    };
  }
}
