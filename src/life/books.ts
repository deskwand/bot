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

export type CreditSource = "owner_topup" | "earned" | "calibration";

type TotalsRow = {
  credit_usd: number;
  spend_usd: number;
  first_spend_at: number | null;
  first_credit_at: number | null;
};
type TotalRow = { total: number | null };
type SourceRow = { source: string; usd: number };

const HOUR_MS = 3_600_000;

/** `task:<id>` runs share one group; bots and every other source stay as-is. */
function groupSource(source: string): string {
  return source.startsWith("task:") ? "task" : source;
}

/**
 * The spend and credit ledger. A one-row totals table keeps the balance and
 * the first-spend time, and an hourly rollup answers the vitals reads without
 * scanning the raw `spend` table.
 */
export class Books {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(closure: () => T) => T = (closure) =>
      closure(),
  ) {
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
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS totals (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        credit_usd REAL NOT NULL,
        spend_usd REAL NOT NULL,
        first_spend_at INTEGER,
        first_credit_at INTEGER
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS spend_hourly (
        hour INTEGER NOT NULL,
        source TEXT NOT NULL,
        usd REAL NOT NULL,
        unpriced INTEGER NOT NULL,
        PRIMARY KEY (hour, source)
      )`,
    );
    this.ensureTotals();
  }

  /** False when `callId` was already recorded. */
  recordSpend(entry: SpendEntry): boolean {
    return this.transaction(() => {
      this.ensureTotals();
      const inserted =
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
        ).rowsWritten > 0;
      if (!inserted) return false;

      this.sql.exec(
        `UPDATE totals SET
          spend_usd = spend_usd + CASE
            WHEN first_credit_at IS NOT NULL AND ? >= first_credit_at THEN ?
            ELSE 0 END,
          first_spend_at = CASE
            WHEN first_spend_at IS NULL OR ? < first_spend_at THEN ?
            ELSE first_spend_at END
         WHERE id = 1`,
        entry.at,
        entry.usd,
        entry.at,
        entry.at,
      );

      this.sql.exec(
        `INSERT INTO spend_hourly (hour, source, usd, unpriced)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (hour, source) DO UPDATE SET
           usd = spend_hourly.usd + excluded.usd,
           unpriced = MAX(spend_hourly.unpriced, excluded.unpriced)`,
        Math.floor(entry.at / HOUR_MS),
        groupSource(entry.source),
        entry.usd,
        entry.priced ? 0 : 1,
      );
      return true;
    });
  }

  recordCredit(
    at: number,
    usd: number,
    source: CreditSource,
    note: string,
  ): void {
    this.transaction(() => {
      this.ensureTotals();
      this.sql.exec(
        `INSERT INTO credit (at, usd, source, note) VALUES (?, ?, ?, ?)`,
        at,
        usd,
        source,
        note,
      );
      // A backdated first credit can bring earlier spend into the balance, so
      // recompute only when the first credit moves earlier.
      this.sql.exec(
        `UPDATE totals SET
          credit_usd = credit_usd + ?,
          spend_usd = CASE
            WHEN first_credit_at IS NULL OR ? < first_credit_at
            THEN (SELECT COALESCE(SUM(usd), 0) FROM spend WHERE at >= ?)
            ELSE spend_usd END,
          first_credit_at = CASE
            WHEN first_credit_at IS NULL OR ? < first_credit_at THEN ?
            ELSE first_credit_at END
         WHERE id = 1`,
        usd,
        at,
        at,
        at,
        at,
      );
    });
  }

  vitalsInput(now: number): VitalsInput {
    const hasCredit =
      this.sql.exec(`SELECT 1 FROM credit LIMIT 1`).toArray().length > 0;
    if (!hasCredit) {
      return {
        now,
        creditTotalUsd: 0,
        spendTotalUsd: 0,
        spendWindowUsd: 0,
        firstSpendAt: null,
        hasCredit: false,
        unpriced: false,
        topSources: [],
      };
    }

    let totals = this.totals();
    if (totals === undefined) {
      this.ensureTotals();
      totals = this.totals();
    }
    const row = totals ?? {
      credit_usd: 0,
      spend_usd: 0,
      first_spend_at: null,
      first_credit_at: null,
    };

    const windowStartHour = Math.floor((now - WINDOW_MS) / HOUR_MS);
    const spendWindowUsd =
      this.sql
        .exec<TotalRow>(
          `SELECT COALESCE(SUM(usd), 0) AS total FROM spend_hourly
           WHERE hour > ?`,
          windowStartHour,
        )
        .toArray()[0]?.total ?? 0;
    const unpriced =
      this.sql
        .exec(
          `SELECT 1 FROM spend_hourly
           WHERE hour > ? AND unpriced = 1 LIMIT 1`,
          windowStartHour,
        )
        .toArray().length > 0;
    const topSources = this.sql
      .exec<SourceRow>(
        `SELECT source, SUM(usd) AS usd FROM spend_hourly
         WHERE hour > ?
         GROUP BY source
         ORDER BY usd DESC, source ASC
         LIMIT 3`,
        windowStartHour,
      )
      .toArray();

    return {
      now,
      creditTotalUsd: row.credit_usd,
      spendTotalUsd: row.spend_usd,
      spendWindowUsd,
      firstSpendAt: row.first_spend_at,
      hasCredit: true,
      unpriced,
      topSources,
    };
  }

  private totals(): TotalsRow | undefined {
    return this.sql
      .exec<TotalsRow>(
        `SELECT credit_usd, spend_usd, first_spend_at, first_credit_at
         FROM totals WHERE id = 1`,
      )
      .toArray()[0];
  }

  /** One-off migration for a ledger written before the rollups existed. */
  private ensureTotals(): void {
    if (this.totals() !== undefined) return;

    const credit =
      this.sql
        .exec<{ total: number | null; first: number | null }>(
          `SELECT COALESCE(SUM(usd), 0) AS total, MIN(at) AS first FROM credit`,
        )
        .toArray()[0] ?? { total: 0, first: null };
    const spend =
      this.sql
        .exec<{ total: number | null; first: number | null }>(
          `SELECT COALESCE(SUM(usd), 0) AS total, MIN(at) AS first FROM spend`,
        )
        .toArray()[0] ?? { total: 0, first: null };
    const chargedUsd =
      credit.first === null
        ? 0
        : (this.sql
            .exec<TotalRow>(
              `SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE at >= ?`,
              credit.first,
            )
            .toArray()[0]?.total ?? 0);

    this.sql.exec(
      `INSERT INTO totals (id, credit_usd, spend_usd, first_spend_at, first_credit_at)
       VALUES (1, ?, ?, ?, ?)`,
      credit.total ?? 0,
      chargedUsd,
      spend.first,
      credit.first,
    );

    this.sql.exec(`DELETE FROM spend_hourly`);
    this.sql.exec(
      `INSERT INTO spend_hourly (hour, source, usd, unpriced)
       SELECT CAST(at / 3600000 AS INTEGER) AS hour,
              CASE WHEN source LIKE 'task:%' THEN 'task' ELSE source END,
              SUM(usd),
              MAX(CASE WHEN priced = 0 THEN 1 ELSE 0 END)
       FROM spend
       GROUP BY hour, 2`,
    );
  }
}
