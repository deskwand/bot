import { t } from "../i18n";
import type { Locale } from "../i18n";

export type LedgerKind = "task.completed" | "bot.message" | "butler.said";

export type LedgerRow = {
  id: number;
  at: number;
  kind: LedgerKind;
  refId: string;
  line: string;
};

export const LEDGER_LINE_MAX = 120;
export const LEDGER_SNIPPET = 80;
export const LEDGER_BATCH = 20;
export const LEDGER_RETENTION_MS = 2_592_000_000;

type RawLedgerRow = {
  id: number;
  at: number;
  kind: string;
  ref_id: string;
  line: string;
};

/** One line of text: newlines folded to spaces, cut to `max` code points. */
export function snippet(text: string, max: number = LEDGER_SNIPPET): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const points = [...flat];
  if (points.length <= max) return flat;
  return `${points.slice(0, max).join("")}…`;
}

function truncate(text: string, max: number): string {
  const points = [...text];
  if (points.length <= max) return text;
  return points.slice(0, max).join("");
}

/**
 * One-line-per-event index of what happened since the owner last spoke.
 * The owner's next turn carries the unread rows as data, never as
 * instructions; the butler session itself keeps no copies.
 */
export class LedgerStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS butler_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER,
        kind TEXT,
        ref_id TEXT,
        line TEXT,
        consumed INTEGER DEFAULT 0
      )`,
    );
  }

  add(kind: LedgerKind, refId: string, line: string, at: number): void {
    this.sql.exec(
      `INSERT INTO butler_ledger (at, kind, ref_id, line) VALUES (?, ?, ?, ?)`,
      at,
      kind,
      refId,
      truncate(line, LEDGER_LINE_MAX),
    );
  }

  /** Unread rows, newest `limit` of them in ascending time order. */
  pending(limit: number = LEDGER_BATCH): {
    rows: LedgerRow[];
    ids: number[];
    omitted: number;
  } {
    const rows = this.sql
      .exec<RawLedgerRow>(
        `SELECT id, at, kind, ref_id, line FROM butler_ledger
         WHERE consumed = 0
         ORDER BY at DESC, id DESC
         LIMIT ?`,
        limit,
      )
      .toArray()
      .reverse()
      .map((row) => ({
        id: row.id,
        at: row.at,
        kind: row.kind as LedgerKind,
        refId: row.ref_id,
        line: row.line,
      }));
    const ids = this.sql
      .exec<{ id: number }>(
        `SELECT id FROM butler_ledger
         WHERE consumed = 0
         ORDER BY at ASC, id ASC`,
      )
      .toArray()
      .map((row) => row.id);
    return { rows, ids, omitted: Math.max(0, ids.length - rows.length) };
  }

  /** The newest `limit` lines of one kind, newest first, read or unread. */
  recentLines(kind: LedgerKind, limit: number): string[] {
    return this.sql
      .exec<{ line: string }>(
        `SELECT line FROM butler_ledger
         WHERE kind = ?
         ORDER BY at DESC, id DESC
         LIMIT ?`,
        kind,
        limit,
      )
      .toArray()
      .map((row) => row.line);
  }

  consume(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    this.sql.exec(
      `UPDATE butler_ledger SET consumed = 1 WHERE id IN (${placeholders})`,
      ...ids,
    );
  }

  /** Drops read rows older than `before`; unread rows always survive. */
  prune(before: number): void {
    this.sql.exec(
      `DELETE FROM butler_ledger WHERE consumed = 1 AND at < ?`,
      before,
    );
  }
}

/** The unread ledger as a prefix for the owner's next message, or "". */
export function renderLedgerPrefix(
  rows: LedgerRow[],
  omitted: number,
  locale: Locale,
): string {
  if (rows.length === 0) return "";
  const lines = [
    t(locale, "phone.ledgerHeader"),
    ...rows.map((row) => `- ${row.line}`),
  ];
  if (omitted > 0) {
    lines.push(t(locale, "phone.ledgerOmitted", { count: omitted }));
  }
  lines.push(t(locale, "phone.ledgerSeparator"));
  return `${lines.join("\n")}\n`;
}
