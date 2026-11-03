export type MemoryItem = { id: number; content: string };

/** How many memories the system prompt section renders each turn. */
export const RENDER_LIMIT = 50;

/**
 * The memory prompt section: every known fact about the owner, newest last,
 * capped so a long-lived Butler cannot blow up the system prompt.
 */
export function renderMemorySection(items: readonly MemoryItem[]): string {
  if (items.length === 0) return "";
  const latest = items.slice(-RENDER_LIMIT);
  return [
    "关于主人的已知信息：",
    ...latest.map((item) => `- ${item.content}`),
  ].join("\n");
}

/** Typed access to the Butler's long-term memory. */
export class MemoryStore {
  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
  }

  add(content: string): number {
    this.sql.exec(
      `INSERT INTO memories (content, created_at) VALUES (?, ?)`,
      content,
      Date.now(),
    );
    return this.sql
      .exec<{ id: number }>(`SELECT last_insert_rowid() AS id`)
      .toArray()[0]!.id;
  }

  /** Substring match over the stored facts, newest first. */
  search(keyword: string, limit = 10): MemoryItem[] {
    return this.sql
      .exec<MemoryItem>(
        `SELECT id, content FROM memories
         WHERE content LIKE ? ESCAPE '\\'
         ORDER BY id DESC LIMIT ?`,
        `%${escapeLike(keyword)}%`,
        limit,
      )
      .toArray();
  }

  remove(id: number): boolean {
    return (
      this.sql.exec(`DELETE FROM memories WHERE id = ?`, id).rowsWritten > 0
    );
  }

  all(): MemoryItem[] {
    return this.sql
      .exec<MemoryItem>(`SELECT id, content FROM memories ORDER BY id ASC`)
      .toArray();
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
