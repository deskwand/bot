export type BotStatus = "active" | "paused" | "finished";

export type BotMeta = {
  botId: string;
  name: string;
  mission: string;
  status: BotStatus;
  nextWakeAt: number | null;
  defaultIntervalMs: number;
  currentTaskId: string | null;
  consecutiveFailures: number;
  wakesDay: string | null;
  wakesCount: number;
  pendingSteer: string[];
};

export type RunOutcome = "completed" | "failed" | "cancelled";

export type RunRow = {
  taskId: string;
  startedAt: number;
  endedAt: number | null;
  outcome: RunOutcome | null;
  summary: string | null;
  note: string | null;
};

type RawRunRow = {
  task_id: string;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  summary: string | null;
  note: string | null;
};

const META_KEY = "bot";

/**
 * Typed access to a Bot's own SQLite storage: the single meta row and the run
 * log. Long-term memories live in a `MemoryStore` on the same storage.
 */
export class BotStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS runs (
        task_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT,
        summary TEXT,
        note TEXT
      )`,
    );
  }

  readMeta(): BotMeta | null {
    const row = this.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, META_KEY)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as BotMeta) : null;
  }

  writeMeta(meta: BotMeta): void {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      META_KEY,
      JSON.stringify(meta),
    );
  }

  insertRun(taskId: string, startedAt: number): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO runs (task_id, started_at) VALUES (?, ?)`,
      taskId,
      startedAt,
    );
  }

  /** When a run started, or null when it is not in the log. */
  runStartedAt(taskId: string): number | null {
    const row = this.sql
      .exec<{ started_at: number }>(
        `SELECT started_at FROM runs WHERE task_id = ?`,
        taskId,
      )
      .toArray()[0];
    return row ? row.started_at : null;
  }

  /** Whether this run already recorded its end. */
  runEnded(taskId: string): boolean {
    const row = this.sql
      .exec<{ task_id: string }>(
        `SELECT task_id FROM runs WHERE task_id = ? AND ended_at IS NOT NULL`,
        taskId,
      )
      .toArray()[0];
    return row !== undefined;
  }

  /**
   * Records the end of a run. A run that never made it into the log is
   * inserted as already ended, because a fast task can report back before
   * `insertRun` runs.
   */
  endRun(
    taskId: string,
    outcome: RunOutcome,
    summary: string,
    endedAt: number,
  ): boolean {
    if (this.runEnded(taskId)) return false;

    const updated = this.sql.exec(
      `UPDATE runs
       SET ended_at = ?, outcome = ?, summary = ?
       WHERE task_id = ? AND ended_at IS NULL`,
      endedAt,
      outcome,
      summary,
      taskId,
    ).rowsWritten;
    if (updated > 0) return true;

    this.sql.exec(
      `INSERT INTO runs (task_id, started_at, ended_at, outcome, summary)
       VALUES (?, ?, ?, ?, ?)`,
      taskId,
      endedAt,
      endedAt,
      outcome,
      summary,
    );
    return true;
  }

  setRunNote(taskId: string, note: string): void {
    const updated = this.sql.exec(
      `UPDATE runs SET note = ? WHERE task_id = ?`,
      note,
      taskId,
    ).rowsWritten;
    if (updated > 0) return;

    // The note can arrive before `insertRun` when a task finishes quickly.
    this.sql.exec(
      `INSERT OR IGNORE INTO runs (task_id, started_at, note) VALUES (?, ?, ?)`,
      taskId,
      Date.now(),
      note,
    );
  }

  recentRuns(limit: number): RunRow[] {
    return this.sql
      .exec<RawRunRow>(
        `SELECT task_id, started_at, ended_at, outcome, summary, note
         FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?`,
        limit,
      )
      .toArray()
      .map((row) => ({
        taskId: row.task_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        outcome: (row.outcome as RunOutcome | null) ?? null,
        summary: row.summary,
        note: row.note,
      }));
  }
}
