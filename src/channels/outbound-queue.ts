import type { Button, MessagePriority } from "../protocol";

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

/** Numeric form of `MessagePriority`, so it can be compared in SQL. */
const PRIORITY: Record<MessagePriority, number> = {
  normal: 0,
  alert: 1,
  critical: 2,
};

/**
 * Durable outbound queue for a channel whose send has no retry of its own. A
 * message is written here before the network call and removed only once the
 * channel accepts it, so a rejected send is carried forward instead of lost.
 * Rows are ordered: a failure keeps every later message behind it.
 *
 * `limit` bounds the backlog. Overflow drops the oldest rows, normal ones
 * first, which keeps the newest message (usually the task result) and never
 * discards a terminal or approval message.
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
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL
      )`,
    );

    // An object created by an older release has no priority column yet.
    const columns = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(outbound_queue)`)
      .toArray();
    if (!columns.some((entry) => entry.name === "priority")) {
      this.sql.exec(
        `ALTER TABLE outbound_queue
         ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }

  /** Adds a message; `dropped` counts the rows the limit pushed out. */
  enqueue(message: {
    conversationId: string;
    text: string;
    buttons: Button[][] | null;
    priority?: MessagePriority;
  }): { id: number; dropped: number } {
    this.sql.exec(
      `INSERT INTO outbound_queue
         (conversation_id, text, buttons_json, priority, last_error, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      message.conversationId,
      message.text,
      message.buttons === null ? null : JSON.stringify(message.buttons),
      PRIORITY[message.priority ?? "normal"],
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

  /**
   * Drops the oldest rows past the limit; returns how many went. Normal rows
   * go before alerts, and critical rows never go at all: the backlog may
   * exceed the limit rather than lose a task result or an approval card.
   */
  private trim(): number {
    const extra = this.count() - this.limit;
    if (extra <= 0) return 0;
    const victims = this.sql
      .exec<{ id: number }>(
        `SELECT id FROM outbound_queue WHERE priority < ?
         ORDER BY priority ASC, id ASC LIMIT ?`,
        PRIORITY.critical,
        extra,
      )
      .toArray();
    for (const victim of victims) {
      this.sql.exec(`DELETE FROM outbound_queue WHERE id = ?`, victim.id);
    }
    return victims.length;
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
