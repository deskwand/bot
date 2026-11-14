export type ScheduleRow = {
  id: string;
  cron: string;
  title: string;
  instructions: string;
  chatId: string | null;
  agentScheduleId: string | null;
  createdAt: number;
  /** Wake time of a one-shot schedule; null for a recurring cron. */
  at: number | null;
};

type RawScheduleRow = {
  id: string;
  cron: string;
  title: string;
  instructions: string;
  chat_id: string | null;
  agent_schedule_id: string | null;
  created_at: number;
  at: number | null;
};

const COUNTER_KEY = "schedule_counter";

/** Raised for a cron expression the tool must report back to the model. */
export class InvalidCronError extends Error {
  constructor(readonly expression: string) {
    super(`cron 表达式无效：${expression}`);
    this.name = "InvalidCronError";
  }
}

/**
 * Minimal structural check: the expressions this Butler accepts are the
 * standard five fields (`minute hour day month weekday`). Range validity is
 * left to `Agent.schedule`, which parses the expression with cron-schedule.
 */
export function validateCron(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new InvalidCronError(expression);
  for (const field of fields) {
    if (!/^[0-9A-Za-z*/,.-]+$/.test(field)) {
      throw new InvalidCronError(expression);
    }
  }
}

/** True when `Agent.schedule` rejected the expression while parsing it. */
export function isCronParseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.startsWith("Invalid cron expression") ||
    message.startsWith("Failed to parse")
  );
}

/** Typed access to the Butler's recurring task definitions. */
export class ScheduleStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        cron TEXT NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        chat_id TEXT,
        agent_schedule_id TEXT,
        created_at INTEGER NOT NULL,
        at INTEGER
      )`,
    );
    // Older objects predate one-shot schedules: `at` is set only by
    // `addOnce`, so a recurring row keeps the column empty.
    const columns = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(schedules)`)
      .toArray();
    if (!columns.some((column) => column.name === "at")) {
      this.sql.exec(`ALTER TABLE schedules ADD COLUMN at INTEGER`);
    }
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS schedules_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    );
  }

  /** Saves a schedule and returns its `s<number>` id. */
  add(
    cron: string,
    instructions: string,
    title: string,
    chatId: string | null = null,
  ): string {
    validateCron(cron);
    const id = this.nextId();
    this.sql.exec(
      `INSERT INTO schedules
        (id, cron, title, instructions, chat_id, agent_schedule_id, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      id,
      cron,
      title,
      instructions,
      chatId,
      Date.now(),
    );
    return id;
  }

  /**
   * Saves a schedule that fires once at `at` and returns its `s<number>` id.
   * The cron column is NOT NULL, so the row carries an empty expression and
   * `at` marks it as one-shot.
   */
  addOnce(
    at: number,
    instructions: string,
    title: string,
    chatId: string | null = null,
  ): string {
    const id = this.nextId();
    this.sql.exec(
      `INSERT INTO schedules
        (id, cron, title, instructions, chat_id, agent_schedule_id, created_at, at)
       VALUES (?, '', ?, ?, ?, NULL, ?, ?)`,
      id,
      title,
      instructions,
      chatId,
      Date.now(),
      at,
    );
    return id;
  }

  setAgentScheduleId(id: string, agentScheduleId: string): void {
    this.sql.exec(
      `UPDATE schedules SET agent_schedule_id = ? WHERE id = ?`,
      agentScheduleId,
      id,
    );
  }

  get(id: string): ScheduleRow | null {
    const row = this.sql
      .exec<RawScheduleRow>(`SELECT * FROM schedules WHERE id = ?`, id)
      .toArray()[0];
    return row ? toScheduleRow(row) : null;
  }

  list(): ScheduleRow[] {
    return this.sql
      .exec<RawScheduleRow>(`SELECT * FROM schedules ORDER BY created_at ASC, id ASC`)
      .toArray()
      .map(toScheduleRow);
  }

  remove(id: string): boolean {
    return this.sql.exec(`DELETE FROM schedules WHERE id = ?`, id).rowsWritten > 0;
  }

  /** Reads one `schedules_meta` value, or null when the key is unset. */
  getMeta(key: string): string | null {
    const row = this.sql
      .exec<{ value: string }>(
        `SELECT value FROM schedules_meta WHERE key = ?`,
        key,
      )
      .toArray()[0];
    return row?.value ?? null;
  }

  /** Writes one `schedules_meta` value, replacing any previous one. */
  setMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO schedules_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  /** Removes one `schedules_meta` value; unset keys are ignored. */
  deleteMeta(key: string): void {
    this.sql.exec(`DELETE FROM schedules_meta WHERE key = ?`, key);
  }

  private nextId(): string {
    const next = Number(this.getMeta(COUNTER_KEY) ?? 0) + 1;
    this.setMeta(COUNTER_KEY, String(next));
    return `s${next}`;
  }
}

function toScheduleRow(row: RawScheduleRow): ScheduleRow {
  return {
    id: row.id,
    cron: row.cron,
    title: row.title,
    instructions: row.instructions,
    chatId: row.chat_id,
    agentScheduleId: row.agent_schedule_id,
    createdAt: row.created_at,
    at: row.at ?? null,
  };
}
