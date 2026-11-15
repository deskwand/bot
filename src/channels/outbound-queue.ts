import type { Button, MessagePriority } from "../protocol";

export type QueuedMessage = {
  id: number;
  conversationId: string;
  text: string;
  buttons: Button[][] | null;
  attempts: number;
  lastError: string | null;
};

/** A queued row plus the connection generation it was written for. */
export type QueuedRow = QueuedMessage & { generation: number };

/** Which WeChat connection (and credential generation) a queue belongs to. */
export type QueueScope = {
  connectionId: string;
  generation: number;
};

/**
 * The pre-members queue: every row an older release wrote belongs to the
 * single owner connection, at generation zero.
 */
export const OWNER_QUEUE_SCOPE: QueueScope = {
  connectionId: "owner",
  generation: 0,
};

type Row = {
  id: number;
  conversation_id: string;
  text: string;
  buttons_json: string | null;
  attempts: number;
  last_error: string | null;
  generation: number;
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
 * Every row belongs to one connection. Two connections dequeue, retry, trim
 * and count independently: a failing connection never blocks or deletes the
 * rows of another, and a generation bump only affects its own backlog.
 *
 * `limit` bounds the backlog. Overflow drops the oldest rows, normal ones
 * first, which keeps the newest message (usually the task result) and never
 * discards a terminal or approval message.
 */
export class OutboundQueue {
  private readonly sql: SqlStorage;

  private readonly scope: QueueScope;

  private readonly limit: number;

  /** Legacy owner queue: `new OutboundQueue(sql, limit)`. */
  constructor(sql: SqlStorage, limit?: number);
  /** One connection's queue: `new OutboundQueue(sql, scope, limit)`. */
  constructor(sql: SqlStorage, scope: QueueScope, limit?: number);
  constructor(
    sql: SqlStorage,
    scopeOrLimit: QueueScope | number = 20,
    limit = 20,
  ) {
    this.sql = sql;
    if (typeof scopeOrLimit === "number") {
      this.scope = OWNER_QUEUE_SCOPE;
      this.limit = scopeOrLimit;
    } else {
      this.scope = {
        connectionId: scopeOrLimit.connectionId,
        generation: scopeOrLimit.generation,
      };
      this.limit = limit;
    }
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS outbound_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL DEFAULT 'owner',
        generation INTEGER NOT NULL DEFAULT 0,
        conversation_id TEXT NOT NULL,
        text TEXT NOT NULL,
        buttons_json TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL
      )`,
    );

    // An object created by an older release has none of the newer columns.
    const columns = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(outbound_queue)`)
      .toArray();
    const has = (name: string) => columns.some((entry) => entry.name === name);
    if (!has("priority")) {
      this.sql.exec(
        `ALTER TABLE outbound_queue
         ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`,
      );
    }
    // Existing rows are the owner's: the defaults migrate them in place.
    if (!has("connection_id")) {
      this.sql.exec(
        `ALTER TABLE outbound_queue
         ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'owner'`,
      );
    }
    if (!has("generation")) {
      this.sql.exec(
        `ALTER TABLE outbound_queue
         ADD COLUMN generation INTEGER NOT NULL DEFAULT 0`,
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
         (connection_id, generation, conversation_id, text, buttons_json,
          priority, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      this.scope.connectionId,
      this.scope.generation,
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
    return this.listCurrent().map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      text: row.text,
      buttons: row.buttons,
      attempts: row.attempts,
      lastError: row.lastError,
    }));
  }

  /** Same rows as `list`, each carrying the generation it was enqueued for. */
  listCurrent(): QueuedRow[] {
    return this.sql
      .exec<Row>(
        `SELECT id, conversation_id, text, buttons_json, attempts, last_error,
                generation
         FROM outbound_queue WHERE connection_id = ? ORDER BY id ASC`,
        this.scope.connectionId,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        text: row.text,
        buttons: parseButtons(row.buttons_json),
        attempts: row.attempts,
        lastError: row.last_error,
        generation: row.generation,
      }));
  }

  /** Drops this connection's backlog; a revoked member gets no more chat. */
  clear(): void {
    this.sql.exec(
      `DELETE FROM outbound_queue WHERE connection_id = ?`,
      this.scope.connectionId,
    );
  }

  markError(id: number, errorCode: string): void {
    this.sql.exec(
      `UPDATE outbound_queue
       SET attempts = attempts + 1, last_error = ?
       WHERE id = ? AND connection_id = ?`,
      errorCode,
      id,
      this.scope.connectionId,
    );
  }

  remove(id: number): void {
    this.sql.exec(
      `DELETE FROM outbound_queue WHERE id = ? AND connection_id = ?`,
      id,
      this.scope.connectionId,
    );
  }

  count(): number {
    const row = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM outbound_queue WHERE connection_id = ?`,
        this.scope.connectionId,
      )
      .toArray()[0];
    return row?.count ?? 0;
  }

  /**
   * Drops the oldest rows past the limit; returns how many went. Normal rows
   * go before alerts, and critical rows never go at all: the backlog may
   * exceed the limit rather than lose a task result or an approval card.
   * Only this connection's rows are candidates.
   */
  private trim(): number {
    const extra = this.count() - this.limit;
    if (extra <= 0) return 0;
    const victims = this.sql
      .exec<{ id: number }>(
        `SELECT id FROM outbound_queue
         WHERE connection_id = ? AND priority < ?
         ORDER BY priority ASC, id ASC LIMIT ?`,
        this.scope.connectionId,
        PRIORITY.critical,
        extra,
      )
      .toArray();
    for (const victim of victims) {
      this.sql.exec(
        `DELETE FROM outbound_queue WHERE id = ? AND connection_id = ?`,
        victim.id,
        this.scope.connectionId,
      );
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
