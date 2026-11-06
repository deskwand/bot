import { artifactKeySegments, artifactNameFromKey } from "../artifact";
import type { Artifact, ChannelMessageRef } from "../protocol";

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
  progressMessageRef: ChannelMessageRef | null;
  summary: string | null;
  artifacts: Artifact[];
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
  botId: string | null;
  handle: number | null;
};

type RawTaskRow = {
  id: string;
  title: string;
  status: string;
  chat_id: string | null;
  progress_message_ref_json: string | null;
  summary: string | null;
  artifacts_json: string | null;
  last_seq: number;
  created_at: number;
  updated_at: number;
  bot_id: string | null;
  handle: number | null;
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

  insert(row: {
    id: string;
    title: string;
    chatId: string | null;
    botId?: string | null;
    handle?: boolean;
  }): void {
    const now = Date.now();
    // Read and write happen in one synchronous step, so two active owner
    // tasks can never end up with the same handle.
    const handle =
      row.botId == null && row.handle !== false ? this.freeHandle() : null;
    this.sql.exec(
      `INSERT INTO tasks (id, title, status, created_at, updated_at, chat_id, artifacts_json, last_seq, bot_id, handle)
       VALUES (?, ?, 'queued', ?, ?, ?, '[]', 0, ?, ?)`,
      row.id,
      row.title,
      now,
      now,
      row.chatId,
      row.botId ?? null,
      handle,
    );
  }

  get(id: string): TaskRow | null {
    const row = this.sql
      .exec<RawTaskRow>(`SELECT * FROM tasks WHERE id = ?`, id)
      .toArray()[0];
    return row ? toTaskRow(row) : null;
  }

  /** Active owner tasks, ordered by their display handle. */
  listActiveOwner(): TaskRow[] {
    const rows = this.sql
      .exec<RawTaskRow>(
        `SELECT * FROM tasks
         WHERE status IN ('queued', 'running') AND bot_id IS NULL
         ORDER BY handle ASC, created_at ASC, id ASC`,
      )
      .toArray();
    return rows.map(toTaskRow);
  }

  /** The active owner task that currently shows `#handle`, if any. */
  findActiveByHandle(handle: number): TaskRow | null {
    const row = this.sql
      .exec<RawTaskRow>(
        `SELECT * FROM tasks
         WHERE status IN ('queued', 'running') AND bot_id IS NULL AND handle = ?`,
        handle,
      )
      .toArray()[0];
    return row ? toTaskRow(row) : null;
  }

  /**
   * Gives a restarted task a handle again. A failed task keeps its old handle
   * for history, but by the time it runs again another task may own it, so a
   * null or conflicting handle is re-assigned the smallest free one.
   */
  ensureHandle(id: string): void {
    const row = this.get(id);
    if (!row || row.botId !== null) return;
    if (row.handle !== null) {
      const taken = this.sql
        .exec<{ id: string }>(
          `SELECT id FROM tasks
           WHERE status IN ('queued', 'running') AND bot_id IS NULL
             AND handle = ? AND id <> ?`,
          row.handle,
          id,
        )
        .toArray();
      if (taken.length === 0) return;
    }
    this.sql.exec(
      `UPDATE tasks SET handle = ? WHERE id = ?`,
      this.freeHandle(id),
      id,
    );
  }

  /**
   * The smallest positive integer not used by an active owner task. Passing
   * `excludeId` lets a row keep counting itself out when it is re-assigned.
   */
  private freeHandle(excludeId?: string): number {
    const rows = this.sql
      .exec<{ handle: number }>(
        `SELECT handle FROM tasks
         WHERE status IN ('queued', 'running') AND handle IS NOT NULL
           AND bot_id IS NULL${excludeId === undefined ? "" : " AND id <> ?"}`,
        ...(excludeId === undefined ? [] : [excludeId]),
      )
      .toArray();
    const used = new Set(rows.map((row) => row.handle));
    let handle = 1;
    while (used.has(handle)) handle += 1;
    return handle;
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
    if (patch.progressMessageRef !== undefined) {
      sets.push("progress_message_ref_json = ?");
      values.push(
        patch.progressMessageRef === null
          ? null
          : JSON.stringify(patch.progressMessageRef),
      );
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
    if (patch.botId !== undefined) {
      sets.push("bot_id = ?");
      values.push(patch.botId);
    }
    // `handle` is assigned only by `insert` and `ensureHandle`; callers never
    // patch it directly.
    sets.push("updated_at = ?");
    values.push(patch.updatedAt ?? Date.now());

    this.sql.exec(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
      ...values,
      id,
    );
  }
}

/** The owner-facing label: the reusable `#N`, or the id for legacy rows. */
export function taskLabel(row: Pick<TaskRow, "id" | "handle">): string {
  return row.handle === null ? row.id : `#${row.handle}`;
}

function toTaskRow(row: RawTaskRow): TaskRow {
  return {
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    chatId: row.chat_id,
    progressMessageRef: parseMessageRef(row.progress_message_ref_json),
    summary: row.summary,
    artifacts: parseArtifacts(row.artifacts_json),
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    botId: row.bot_id,
    handle: row.handle,
  };
}

function parseMessageRef(json: string | null): ChannelMessageRef | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ChannelMessageRef;
  } catch {
    return null;
  }
}

function parseArtifacts(json: string | null): Artifact[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const artifacts: Artifact[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const key =
      typeof record.key === "string" ? record.key : keyFromLegacyUrl(record.url);
    // 长度不是三段的 key 不可能是产物；丢弃而不是让它在发送时爆炸。
    if (key === null || artifactKeySegments(key) === null) continue;
    artifacts.push({ name: artifactNameFromKey(key), key });
  }
  return artifacts;
}

/** 旧记录只有公开 URL：能还原出 key 就还原，其余丢弃。 */
function keyFromLegacyUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^https?:\/\/[^/?#]+\/a\/([^?#]+)$/.exec(value);
  if (!match) return null;
  try {
    return match[1]!.split("/").map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    return null;
  }
}
