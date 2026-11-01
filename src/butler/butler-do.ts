import { Agent } from "agents";
import type { MessageEvent, TaskEvent, TaskEventBody } from "../protocol";

type TaskEventRow = {
  seq: number;
  type: string;
  payload_json: string;
};

/**
 * Control-plane object: the Butler agent lives here. This task only adds the
 * task index and deduplicated event intake; notifications land in Task 10.
 */
export class ButlerDO extends Agent<Env> {
  private readonly db: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        chat_id TEXT,
        progress_message_id TEXT,
        summary TEXT,
        artifacts_json TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS task_events (
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (task_id, seq)
      )`,
    );
  }

  /**
   * RPC entry for inbound channel messages. `Agent` reserves the name
   * `onMessage` for its hibernating-WebSocket handler (and hide it from RPC),
   * so the gateway's `onMessage` is mapped here in `src/index.ts`.
   */
  async handleMessage(evt: MessageEvent): Promise<void> {
    await this.handleInboundMessage(evt);
  }

  private async handleInboundMessage(_evt: MessageEvent): Promise<void> {}

  async report(event: TaskEvent): Promise<void> {
    const now = Date.now();

    // Events can arrive before the Butler has spawned/indexed the task.
    this.db.exec(
      `INSERT INTO tasks (id, title, status, created_at, updated_at)
       VALUES (?, '', 'queued', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      event.taskId,
      now,
      now,
    );

    const row = this.db
      .exec<{ last_seq: number }>(
        `SELECT last_seq FROM tasks WHERE id = ?`,
        event.taskId,
      )
      .toArray()[0];
    if (!row) return;

    // Dedupe: a redelivered or older event is acknowledged and dropped.
    if (event.seq <= row.last_seq) return;

    const { taskId, seq, ...body } = event;
    this.ctx.storage.transactionSync(() => {
      this.db.exec(
        `UPDATE tasks SET last_seq = ?, updated_at = ? WHERE id = ?`,
        seq,
        now,
        taskId,
      );
      this.db.exec(
        `INSERT INTO task_events (task_id, seq, type, payload_json)
         VALUES (?, ?, ?, ?)`,
        taskId,
        seq,
        body.type,
        JSON.stringify(body),
      );
    });
  }

  /** Test-only seam: list the events recorded for a task, in seq order. */
  debugEvents(
    taskId: string,
  ): { seq: number; type: string; payload: TaskEventBody }[] {
    return this.db
      .exec<TaskEventRow>(
        `SELECT seq, type, payload_json FROM task_events
         WHERE task_id = ? ORDER BY seq ASC`,
        taskId,
      )
      .toArray()
      .map((row) => ({
        seq: row.seq,
        type: row.type,
        payload: JSON.parse(row.payload_json) as TaskEventBody,
      }));
  }
}
