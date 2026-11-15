import { describe, expect, it } from "vitest";
import {
  MAX_TABLES_PER_BATCH,
  readBatch,
  type PageSource,
} from "../../src/admin/backup-batch";
import type { DumpPage, DumpRow, TableSchema } from "../../src/admin/sql-dump";

type PageSpec = { rows: DumpRow[]; bytes: number; next: string | null };

/** A page source that serves one table's pages in order from its cursor. */
function source(spec: Record<string, PageSpec[]>): PageSource {
  return {
    async backupPage(
      table: TableSchema,
      cursor: string | null,
    ): Promise<DumpPage> {
      const pages = spec[table.name] ?? [];
      const index = cursor === null ? 0 : Number(cursor);
      return pages[index] ?? { rows: [], bytes: 0, next: null };
    },
  };
}

function table(name: string): TableSchema {
  return { name, create: "", withoutRowid: false };
}

const row = (n: number): DumpRow => ({ n });

describe("readBatch", () => {
  it("packs several whole tables into one batch while the budget lasts", async () => {
    const tables = [table("a"), table("b"), table("c")];
    const result = await readBatch(
      source({
        a: [{ rows: [row(1)], bytes: 100, next: null }],
        b: [{ rows: [row(2)], bytes: 100, next: null }],
        c: [{ rows: [row(3)], bytes: 100, next: null }],
      }),
      tables,
      { index: 0, cursor: null },
      150,
    );

    expect(result.chunks.map((chunk) => chunk.table)).toEqual(["a", "b"]);
    expect(result.state).toEqual({ index: 2, cursor: null });
    expect(result.done).toBe(false);
  });

  it("stops on a partial table and resumes from its cursor", async () => {
    const tables = [table("big"), table("small")];
    const pages = source({
      big: [
        { rows: [row(1)], bytes: 600, next: "1" },
        { rows: [row(2)], bytes: 100, next: null },
      ],
      small: [{ rows: [row(3)], bytes: 100, next: null }],
    });

    const first = await readBatch(
      pages,
      tables,
      { index: 0, cursor: null },
      1000,
    );
    expect(first.chunks).toHaveLength(1);
    expect(first.chunks[0]!.next).toBe("1");
    expect(first.state).toEqual({ index: 0, cursor: "1" });
    expect(first.done).toBe(false);

    const second = await readBatch(pages, tables, first.state, 1000);
    expect(second.chunks.map((chunk) => chunk.table)).toEqual(["big", "small"]);
    expect(second.chunks[0]!.next).toBeNull();
    expect(second.done).toBe(true);
  });

  it("reports done only after the last table", async () => {
    const result = await readBatch(
      source({
        a: [{ rows: [], bytes: 0, next: null }],
        b: [{ rows: [], bytes: 0, next: null }],
      }),
      [table("a"), table("b")],
      { index: 1, cursor: null },
      1000,
    );
    expect(result.chunks.map((chunk) => chunk.table)).toEqual(["b"]);
    expect(result.state).toEqual({ index: 2, cursor: null });
    expect(result.done).toBe(true);
  });

  it("treats a spent budget as the end of the batch even when tables remain", async () => {
    const result = await readBatch(
      source({
        a: [{ rows: [row(1)], bytes: 5000, next: null }],
        b: [{ rows: [row(2)], bytes: 100, next: null }],
      }),
      [table("a"), table("b")],
      { index: 0, cursor: null },
      1000,
    );
    expect(result.chunks.map((chunk) => chunk.table)).toEqual(["a"]);
    expect(result.done).toBe(false);
  });

  it("caps how many tables one request reads", async () => {
    const tables = Array.from({ length: MAX_TABLES_PER_BATCH + 5 }, (_, i) =>
      table(`t${i}`),
    );
    const spec: Record<string, PageSpec[]> = {};
    for (const t of tables) spec[t.name] = [{ rows: [], bytes: 0, next: null }];

    const result = await readBatch(
      source(spec),
      tables,
      { index: 0, cursor: null },
      10 << 20,
    );
    expect(result.chunks).toHaveLength(MAX_TABLES_PER_BATCH);
    expect(result.state).toEqual({ index: MAX_TABLES_PER_BATCH, cursor: null });
    expect(result.done).toBe(false);
  });
});
