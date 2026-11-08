/** One owner message whose answer has not been delivered yet. */
export type TurnRow = {
  operationId: string;
  submittedAt: number;
  startedAt: number | null;
  ackAt: number | null;
  noticeAt: number | null;
  signature: string | null;
  activityAt: number;
  deliveringAt: number | null;
  attempts: number;
  retriedAt: number | null;
  retryAt: number | null;
  abandonedAt: number | null;
  supersededAt: number | null;
};

type Row = {
  operation_id: string;
  submitted_at: number;
  started_at: number | null;
  ack_at: number | null;
  spoke_at: number | null;
  notice_at: number | null;
  signature: string | null;
  activity_at: number;
  delivering_at: number | null;
  attempts: number;
  retried_at: number | null;
  retry_at: number | null;
  abandoned_at: number | null;
  superseded_at: number | null;
};

function toTurn(row: Row): TurnRow {
  return {
    operationId: row.operation_id,
    submittedAt: row.submitted_at,
    startedAt: row.started_at,
    ackAt: row.ack_at,
    noticeAt: row.notice_at,
    signature: row.signature,
    activityAt: row.activity_at,
    deliveringAt: row.delivering_at,
    attempts: row.attempts,
    retriedAt: row.retried_at,
    retryAt: row.retry_at,
    abandonedAt: row.abandoned_at,
    supersededAt: row.superseded_at,
  };
}

/**
 * Delivery ledger for owner messages. One row per `eventId`, written after the
 * submit is accepted and removed only after the terminal message went out, so a
 * restart can pick the turn up instead of losing it.
 */
export class TurnStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS butler_turns (
        operation_id TEXT PRIMARY KEY,
        submitted_at INTEGER NOT NULL,
        started_at INTEGER,
        ack_at INTEGER,
        spoke_at INTEGER,
        notice_at INTEGER,
        signature TEXT,
        activity_at INTEGER NOT NULL,
        delivering_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        retried_at INTEGER,
        retry_at INTEGER,
        abandoned_at INTEGER
      )`,
    );
    const columns = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(butler_turns)`)
      .toArray();
    for (const column of [
      { name: "retry_at", type: "INTEGER" },
      { name: "abandoned_at", type: "INTEGER" },
      { name: "superseded_at", type: "INTEGER" },
    ]) {
      if (!columns.some((entry) => entry.name === column.name)) {
        this.sql.exec(
          `ALTER TABLE butler_turns ADD COLUMN ${column.name} ${column.type}`,
        );
      }
    }
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS butler_answers (
        answer_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        claimed_at INTEGER NOT NULL
      )`,
    );
  }

  /** True when this call created the row; false when it already existed. */
  insertIfAbsent(row: { operationId: string; submittedAt: number }): boolean {
    if (this.get(row.operationId) !== undefined) return false;
    // Optimistic: an idle conversation starts the run on submit, so the stall
    // clock counts from here. A queued turn clears it again in `start`.
    this.sql.exec(
      `INSERT INTO butler_turns (operation_id, submitted_at, started_at, activity_at)
       VALUES (?, ?, ?, ?)`,
      row.operationId,
      row.submittedAt,
      row.submittedAt,
      row.submittedAt,
    );
    return true;
  }

  get(operationId: string): TurnRow | undefined {
    const row = this.sql
      .exec<Row>(
        `SELECT * FROM butler_turns WHERE operation_id = ?`,
        operationId,
      )
      .toArray()[0];
    return row === undefined ? undefined : toTurn(row);
  }

  list(): TurnRow[] {
    return this.sql
      .exec<Row>(
        `SELECT * FROM butler_turns
         WHERE abandoned_at IS NULL
         ORDER BY submitted_at ASC, operation_id ASC`,
      )
      .toArray()
      .map(toTurn);
  }

  /**
   * `queued`: this turn has not started yet, so its stall clock must not run.
   * `running`: keep the optimistic start, or start the clock now for a turn
   * that had queued behind another one.
   */
  start(operationId: string, now: number, queued: boolean): void {
    const row = this.get(operationId);
    if (row === undefined) return;
    if (queued) {
      if (row.startedAt !== null) {
        this.sql.exec(
          `UPDATE butler_turns SET started_at = NULL WHERE operation_id = ?`,
          operationId,
        );
      }
      return;
    }
    if (row.startedAt !== null) return;
    this.sql.exec(
      `UPDATE butler_turns SET started_at = ?, activity_at = ?
       WHERE operation_id = ?`,
      now,
      now,
      operationId,
    );
  }

  ack(operationId: string, now: number): void {
    this.sql.exec(
      `UPDATE butler_turns SET ack_at = ? WHERE operation_id = ? AND ack_at IS NULL`,
      now,
      operationId,
    );
  }

  /** A stall notice also settles the ack: one message is enough. */
  notice(operationId: string, now: number): void {
    this.sql.exec(
      `UPDATE butler_turns
       SET notice_at = ?, ack_at = COALESCE(ack_at, ?)
       WHERE operation_id = ?`,
      now,
      now,
      operationId,
    );
  }

  /** True when the observed state differs from the stored one. */
  observe(operationId: string, signature: string, now: number): boolean {
    const row = this.get(operationId);
    if (row === undefined || row.signature === signature) return false;
    this.sql.exec(
      `UPDATE butler_turns
       SET signature = ?, activity_at = ?, notice_at = NULL
       WHERE operation_id = ?`,
      signature,
      now,
      operationId,
    );
    return true;
  }

  delivering(operationId: string, now: number): void {
    this.sql.exec(
      `UPDATE butler_turns SET delivering_at = ? WHERE operation_id = ?`,
      now,
      operationId,
    );
  }

  /** Increments the failure count and returns the new total. */
  fail(operationId: string): number {
    this.sql.exec(
      `UPDATE butler_turns
       SET attempts = attempts + 1, delivering_at = NULL
       WHERE operation_id = ?`,
      operationId,
    );
    return this.get(operationId)?.attempts ?? 0;
  }

  /** When the next delivery attempt may run. */
  retryAt(operationId: string, at: number): void {
    this.sql.exec(
      `UPDATE butler_turns SET retry_at = ? WHERE operation_id = ?`,
      at,
      operationId,
    );
  }

  /**
   * Gives up on a turn without forgetting it: the row stays as a tombstone so
   * the rebuild loop cannot resurrect an operation that is still in `pending()`.
   */
  abandon(operationId: string, now: number): void {
    this.sql.exec(
      `UPDATE butler_turns
       SET abandoned_at = ?, delivering_at = NULL
       WHERE operation_id = ?`,
      now,
      operationId,
    );
  }

  retried(operationId: string, now: number): void {
    this.sql.exec(
      `UPDATE butler_turns SET retried_at = ? WHERE operation_id = ?`,
      now,
      operationId,
    );
  }

  /**
   * Marks a turn a newer message replaced. Only the first mark counts: the
   * abort that follows must not move it under a settled answer.
   */
  supersede(operationId: string, now: number): void {
    this.sql.exec(
      `UPDATE butler_turns SET superseded_at = ?
       WHERE operation_id = ? AND superseded_at IS NULL`,
      now,
      operationId,
    );
  }

  remove(operationId: string): void {
    this.sql.exec(
      `DELETE FROM butler_turns WHERE operation_id = ?`,
      operationId,
    );
  }

  /**
   * Claims the one answer a merged turn settles every queued operation with.
   * True when this operation owns it, including on its own retry.
   */
  claimAnswer(answerId: string, operationId: string, now: number): boolean {
    this.sql.exec(
      `INSERT OR IGNORE INTO butler_answers (answer_id, operation_id, claimed_at)
       VALUES (?, ?, ?)`,
      answerId,
      operationId,
      now,
    );
    const row = this.sql
      .exec<{ operation_id: string }>(
        `SELECT operation_id FROM butler_answers WHERE answer_id = ?`,
        answerId,
      )
      .toArray()[0];
    return row?.operation_id === operationId;
  }

  pruneAnswers(before: number): void {
    this.sql.exec(
      `DELETE FROM butler_answers WHERE claimed_at < ?`,
      before,
    );
  }
}
