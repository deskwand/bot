import type { TaskEvent, TaskEventBody } from "../protocol";

type EventRow = { seq: number; payload_json: string };

/**
 * Durable, ordered outbox for events reported from a Task DO to the Butler.
 *
 * `emit` writes the event with `delivered = 0` and immediately tries to
 * deliver everything pending. Delivery stops at the first failure so events
 * are always reported in seq order; the remaining rows are retried by the
 * next `flush`.
 */
export class Outbox {
  constructor(
    private readonly sql: SqlStorage,
    private readonly taskId: string,
    private readonly deliver: (event: TaskEvent) => Promise<void>,
    private readonly onFailure?: (excludeRetryId?: string) => Promise<void>,
  ) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      )`,
    );
  }

  async emit(body: TaskEventBody): Promise<void> {
    this.sql.exec(
      `INSERT INTO events (type, payload_json, delivered) VALUES (?, ?, 0)`,
      body.type,
      JSON.stringify(body),
    );
    await this.flush();
  }

  async flush(excludeRetryId?: string): Promise<boolean> {
    const rows = this.sql
      .exec<EventRow>(
        `SELECT seq, payload_json FROM events
         WHERE delivered = 0 ORDER BY seq ASC`,
      )
      .toArray();

    for (const row of rows) {
      const body = JSON.parse(row.payload_json) as TaskEventBody;
      try {
        await this.deliver({ ...body, taskId: this.taskId, seq: row.seq });
      } catch {
        // Keep this and later events undelivered: order matters.
        await this.onFailure?.(excludeRetryId);
        return false;
      }
      this.sql.exec(`UPDATE events SET delivered = 1 WHERE seq = ?`, row.seq);
    }
    return true;
  }
}
