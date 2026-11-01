import type { Artifact } from "../protocol";

export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskRow = {
  id: string;
  title: string;
  status: TaskStatus;
  chatId: string | null;
  progressMessageId: string | null;
  summary: string | null;
  artifacts: Artifact[];
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
};

type RawTaskRow = {
  id: string;
  title: string;
  status: string;
  chat_id: string | null;
  progress_message_id: string | null;
  summary: string | null;
  artifacts_json: string | null;
  last_seq: number;
  created_at: number;
  updated_at: number;
};

const COUNTER_KEY = "task_counter";

/**
 * Typed access to the Butler's `tasks` index. The table is created by the
 * Butler; this class only reads and writes it.
 */
export class TasksRepo {
  constructor(private readonly sql: SqlStorage) {}

  /**
   * Next task id, `t1`, `t2`, … The counter lives in the `meta` table so it
   * survives restarts and never reuses an id.
   */
  nextId(): string {
    const row = this.sql
      .exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = ?`,
        COUNTER_KEY,
      )
      .toArray()[0];
    const next = Number(row?.value ?? 0) + 1;
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      COUNTER_KEY,
      String(next),
    );
    return `t${next}`;
  }

  insert(row: { id: string; title: string; chatId: string | null }): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO tasks (id, title, status, created_at, updated_at, chat_id, artifacts_json, last_seq)
       VALUES (?, ?, 'queued', ?, ?, ?, '[]', 0)`,
      row.id,
      row.title,
      now,
      now,
      row.chatId,
    );
  }

  get(id: string): TaskRow | null {
    const row = this.sql
      .exec<RawTaskRow>(`SELECT * FROM tasks WHERE id = ?`, id)
      .toArray()[0];
    return row ? toTaskRow(row) : null;
  }

  list(filter?: { active?: boolean }): TaskRow[] {
    const rows = filter?.active
      ? this.sql
          .exec<RawTaskRow>(
            `SELECT * FROM tasks WHERE status IN ('queued', 'running')
             ORDER BY created_at ASC, id ASC`,
          )
          .toArray()
      : this.sql
          .exec<RawTaskRow>(`SELECT * FROM tasks ORDER BY created_at ASC, id ASC`)
          .toArray();
    return rows.map(toTaskRow);
  }

  update(id: string, patch: Partial<TaskRow>): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.chatId !== undefined) {
      sets.push("chat_id = ?");
      values.push(patch.chatId);
    }
    if (patch.progressMessageId !== undefined) {
      sets.push("progress_message_id = ?");
      values.push(patch.progressMessageId);
    }
    if (patch.summary !== undefined) {
      sets.push("summary = ?");
      values.push(patch.summary);
    }
    if (patch.artifacts !== undefined) {
      sets.push("artifacts_json = ?");
      values.push(JSON.stringify(patch.artifacts));
    }
    if (patch.lastSeq !== undefined) {
      sets.push("last_seq = ?");
      values.push(patch.lastSeq);
    }
    if (patch.createdAt !== undefined) {
      sets.push("created_at = ?");
      values.push(patch.createdAt);
    }
    sets.push("updated_at = ?");
    values.push(patch.updatedAt ?? Date.now());

    this.sql.exec(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
      ...values,
      id,
    );
  }
}

function toTaskRow(row: RawTaskRow): TaskRow {
  return {
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    chatId: row.chat_id,
    progressMessageId: row.progress_message_id,
    summary: row.summary,
    artifacts: parseArtifacts(row.artifacts_json),
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseArtifacts(json: string | null): Artifact[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Artifact[]) : [];
  } catch {
    return [];
  }
}
