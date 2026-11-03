export type BotIndexRow = {
  id: string;
  name: string;
  createdAt: number;
};

type RawBotRow = {
  id: string;
  name: string;
  created_at: number;
};

const COUNTER_KEY = "bot_counter";

/**
 * The Butler's index of its bots: ids and names only. Status, memories and
 * wake times live in the BotDO, which owns them and can change them on its own
 * (for example pausing itself), so a copy here would only go stale.
 */
export class BotsRepo {
  constructor(private readonly sql: SqlStorage) {}

  /** Next bot id, `b1`, `b2`, … The counter lives in the `meta` table. */
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
    return `b${next}`;
  }

  insert(row: { id: string; name: string }): void {
    this.sql.exec(
      `INSERT INTO bots (id, name, created_at) VALUES (?, ?, ?)`,
      row.id,
      row.name,
      Date.now(),
    );
  }

  get(id: string): BotIndexRow | null {
    const row = this.sql
      .exec<RawBotRow>(`SELECT * FROM bots WHERE id = ?`, id)
      .toArray()[0];
    return row ? toBotIndexRow(row) : null;
  }

  list(): BotIndexRow[] {
    return this.sql
      .exec<RawBotRow>(`SELECT * FROM bots ORDER BY created_at ASC, id ASC`)
      .toArray()
      .map(toBotIndexRow);
  }

  remove(id: string): boolean {
    return this.sql.exec(`DELETE FROM bots WHERE id = ?`, id).rowsWritten > 0;
  }
}

function toBotIndexRow(row: RawBotRow): BotIndexRow {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  };
}
