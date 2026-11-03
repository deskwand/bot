import type { Button } from "../protocol";

export type QueuedMessage = {
  id: number;
  conversationId: string;
  text: string;
  buttons: Button[][] | null;
  attempts: number;
  lastError: string | null;
};

type Row = {
  id: number;
  conversation_id: string;
  text: string;
  buttons_json: string | null;
  attempts: number;
  last_error: string | null;
};

/**
 * Durable outbound queue for a channel whose send has no retry of its own. A
 * message is written here before the network call and removed only once the
 * channel accepts it, so a rejected send is carried forward instead of lost.
 * Rows are ordered: a failure keeps every later message behind it.
 *
 * `limit` bounds the backlog. Overflow drops the oldest row, which keeps the
 * newest message (usually the task result) rather than the stalest frame.
 */
export class OutboundQueue {
  constructor(
    private readonly sql: SqlStorage,
    private readonly limit = 20,
  ) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS outbound_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        text TEXT NOT NULL,
        buttons_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL
      )`,
    );
  }

  /** Adds a message; `dropped` counts the oldest rows the limit pushed out. */
  enqueue(message: {
    conversationId: string;
    text: string;
    buttons: Button[][] | null;
  }): { id: number; dropped: number } {
    this.sql.exec(
      `INSERT INTO outbound_queue
         (conversation_id, text, buttons_json, last_error, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
      message.conversationId,
      message.text,
      message.buttons === null ? null : JSON.stringify(message.buttons),
      Date.now(),
    );
    const inserted = this.sql
      .exec<{ id: number }>(`SELECT last_insert_rowid() AS id`)
      .toArray()[0];
    return { id: inserted?.id ?? 0, dropped: this.trim() };
  }

  list(): QueuedMessage[] {
    return this.sql
      .exec<Row>(
        `SELECT id, conversation_id, text, buttons_json, attempts, last_error
         FROM outbound_queue ORDER BY id ASC`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        text: row.text,
        buttons: parseButtons(row.buttons_json),
        attempts: row.attempts,
        lastError: row.last_error,
      }));
  }

  markError(id: number, errorCode: string): void {
    this.sql.exec(
      `UPDATE outbound_queue
       SET attempts = attempts + 1, last_error = ?
       WHERE id = ?`,
      errorCode,
      id,
    );
  }

  remove(id: number): void {
    this.sql.exec(`DELETE FROM outbound_queue WHERE id = ?`, id);
  }

  count(): number {
    const row = this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM outbound_queue`)
      .toArray()[0];
    return row?.count ?? 0;
  }

  /** Drops the oldest rows past the limit; returns how many went. */
  private trim(): number {
    const extra = this.count() - this.limit;
    if (extra <= 0) return 0;
    this.sql.exec(
      `DELETE FROM outbound_queue WHERE id IN (
         SELECT id FROM outbound_queue ORDER BY id ASC LIMIT ?
       )`,
      extra,
    );
    return extra;
  }
}

/** A corrupt column must not wedge the queue: read it as "no buttons". */
function parseButtons(json: string | null): Button[][] | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as Button[][];
  } catch {
    return null;
  }
}
