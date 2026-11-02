import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createIndexes,
  createTables,
  PAGE_BYTES,
  readPage,
  readSchema,
  writePage,
  type DbSchema,
  type DumpPage,
  type DumpRow,
  type TableSchema,
} from "../../src/admin/sql-dump";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function harness(name: string) {
  return env.TEST_HARNESS.get(env.TEST_HARNESS.idFromName(name));
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function dump(sql: SqlStorage, table: TableSchema, maxBytes?: number): DumpPage[] {
  const pages: DumpPage[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10_000; i += 1) {
    const page = readPage(sql, table, cursor, maxBytes);
    pages.push(page);
    cursor = page.next;
    if (cursor === null) return pages;
  }
  throw new Error("too many pages");
}

function findTable(schema: DbSchema, name: string): TableSchema {
  const table = schema.tables.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`missing table ${name}`);
  return table;
}

function quotedRows(
  sql: SqlStorage,
  table: string,
  orderBy: string,
): string[][] {
  const columns = sql
    .exec<{ name: string }>(`PRAGMA table_info(${quoteIdent(table)})`)
    .toArray()
    .map((column) => column.name);
  const select = columns
    .map((column) => `quote(${quoteIdent(column)}) AS ${quoteIdent(column)}`)
    .join(", ");
  return sql
    .exec<Record<string, string>>(
      `SELECT ${select} FROM ${quoteIdent(table)} ORDER BY ${orderBy}`,
    )
    .toArray()
    .map((row) => columns.map((column) => row[column]!));
}

function rowsOf(pages: DumpPage[]): DumpRow[] {
  return pages.flatMap((page) => page.rows);
}

describe("sql-dump", () => {
  it("round-trips every SQLite value class", async () => {
    const source = harness("dump-values");
    const captured = await runInDurableObject(source, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT, n INTEGER, r REAL, b BLOB, z)`,
      );
      sql.exec(
        `INSERT INTO t (id, s, n, r, b, z)
         VALUES (1, ?, CAST('9007199254740993' AS INTEGER), 1.5, X'00ff', NULL)`,
        "a'b",
      );
      sql.exec(
        `CREATE TABLE st (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT`,
      );
      sql.exec(`INSERT INTO st (id, label) VALUES (1, 'strict')`);
      sql.exec(`CREATE TABLE w (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
      sql.exec(`INSERT INTO w (k, v) VALUES ('k1', 'v1'), ('k2', 'v2')`);
      sql.exec(`CREATE INDEX t_n ON t (n)`);

      const schema = readSchema(sql);
      const pages = Object.fromEntries(
        ["t", "st", "w"].map((name) => [
          name,
          dump(sql, findTable(schema, name)),
        ]),
      );
      return { schema, pages };
    });

    expect(findTable(captured.schema, "w").withoutRowid).toBe(true);
    const tRow = captured.pages.t![0]!.rows[0]!;
    expect(tRow.__rowid).toBe(1);
    expect(tRow.n).toEqual({ $int: "9007199254740993" });
    expect(tRow.b).toEqual({ $blob: "AP8=" });
    expect(tRow.s).toBe("a'b");
    expect(tRow.z).toBeNull();
    expect(tRow.r).toEqual({ $real: "1.5" });

    const target = harness("dump-values-target");
    await runInDurableObject(target, (_instance, state) => {
      const sql = state.storage.sql;
      createTables(sql, captured.schema);
      for (const name of ["t", "st", "w"]) {
        writePage(
          sql,
          findTable(captured.schema, name),
          rowsOf(captured.pages[name]!),
        );
      }
      createIndexes(sql, captured.schema);
    });

    const readBack = await runInDurableObject(target, (_instance, state) => ({
      t: quotedRows(state.storage.sql, "t", "rowid"),
      st: quotedRows(state.storage.sql, "st", "rowid"),
      w: quotedRows(state.storage.sql, "w", "k"),
      index: state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 't_n'`,
        )
        .toArray(),
    }));

    expect(readBack.index.map((row) => row.name)).toEqual(["t_n"]);
    expect(readBack.t).toEqual([
      ["1", "'a''b'", "9007199254740993", "1.5", "X'00FF'", "NULL"],
    ]);
    expect(readBack.st).toEqual([["1", "'strict'"]]);
    expect(readBack.w).toEqual([
      ["'k1'", "'v1'"],
      ["'k2'", "'v2'"],
    ]);
  });

  it("round-trips a rowid beyond the safe integer range", async () => {
    const source = harness("dump-big-rowid");
    const captured = await runInDurableObject(source, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE u (x TEXT)`);
      sql.exec(
        `INSERT INTO u (rowid, x) VALUES (CAST('9007199254740993' AS INTEGER), 'big')`,
      );
      const schema = readSchema(sql);
      return {
        schema,
        pages: dump(sql, findTable(schema, "u")),
      };
    });

    const row = captured.pages[0]!.rows[0]!;
    expect(row.__rowid).toEqual({ $int: "9007199254740993" });

    const target = harness("dump-big-rowid-target");
    const readBack = await runInDurableObject(target, (_instance, state) => {
      const sql = state.storage.sql;
      createTables(sql, captured.schema);
      writePage(sql, findTable(captured.schema, "u"), rowsOf(captured.pages));
      return sql
        .exec<{ rowid: string }>(
          `SELECT quote(rowid) AS rowid FROM u`,
        )
        .toArray();
    });

    expect(readBack.map((row) => row.rowid)).toEqual(["9007199254740993"]);
  });

  it("keeps integer and real storage classes exact through JSON", async () => {
    const source = harness("dump-storage-classes");
    const captured = await runInDurableObject(source, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE typed (id INTEGER PRIMARY KEY, v)`);
      sql.exec(`INSERT INTO typed (id, v) VALUES (1, 5)`);
      sql.exec(`INSERT INTO typed (id, v) VALUES (2, CAST(5.0 AS REAL))`);
      sql.exec(`INSERT INTO typed (id, v) VALUES (3, 1.5)`);
      sql.exec(`INSERT INTO typed (id, v) VALUES (4, 9e999)`);
      sql.exec(`INSERT INTO typed (id, v) VALUES (5, -9e999)`);
      const schema = readSchema(sql);
      const pages = dump(sql, findTable(schema, "typed"));
      const rows = rowsOf(pages).map(
        (row) => JSON.parse(JSON.stringify(row)) as DumpRow,
      );
      const expected = sql
        .exec<{ id: number; t: string; q: string }>(
          `SELECT id, typeof(v) AS t, quote(v) AS q FROM typed ORDER BY id`,
        )
        .toArray();
      return { schema, rows, expected };
    });

    expect(captured.rows.map((row) => row.v)).toEqual([
      5,
      { $real: "5.0" },
      { $real: "1.5" },
      { $real: "9.0e+999" },
      { $real: "-9.0e+999" },
    ]);

    const target = harness("dump-storage-classes-target");
    const readBack = await runInDurableObject(target, (_instance, state) => {
      const sql = state.storage.sql;
      createTables(sql, captured.schema);
      writePage(sql, findTable(captured.schema, "typed"), captured.rows);
      return sql
        .exec<{ id: number; t: string; q: string }>(
          `SELECT id, typeof(v) AS t, quote(v) AS q FROM typed ORDER BY id`,
        )
        .toArray();
    });

    expect(readBack).toEqual(captured.expected);
    expect(readBack.map((row) => row.t)).toEqual([
      "integer",
      "real",
      "real",
      "real",
      "real",
    ]);
  });

  it("excludes sqlite_, _cf_ and admin_maintenance tables", async () => {
    const source = harness("dump-excludes");
    const schema = await runInDurableObject(source, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `CREATE TABLE admin_maintenance (singleton INTEGER PRIMARY KEY, until INTEGER)`,
      );
      sql.exec(
        `CREATE INDEX admin_maintenance_until ON admin_maintenance (until)`,
      );
      sql.exec(`CREATE TABLE autoinc (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)`);
      sql.exec(`INSERT INTO autoinc (v) VALUES ('x')`);
      sql.exec(`CREATE INDEX autoinc_v ON autoinc (v)`);
      return readSchema(sql);
    });

    const names = schema.tables.map((table) => table.name);
    expect(names).toContain("autoinc");
    expect(names).not.toContain("admin_maintenance");
    expect(names).not.toContain("sqlite_sequence");
    expect(names.some((name) => name.startsWith("sqlite_"))).toBe(false);
    expect(names.some((name) => name.startsWith("_cf_"))).toBe(false);
    expect(
      schema.indexes.some((sql) => sql.includes("admin_maintenance_until")),
    ).toBe(false);
    expect(schema.indexes.some((sql) => sql.includes("autoinc_v"))).toBe(true);
  });

  it("skips FTS virtual tables and their shadow tables", async () => {
    const source = harness("dump-fts");
    const captured = await runInDurableObject(source, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE normal (id INTEGER PRIMARY KEY, v TEXT)`);
      sql.exec(`INSERT INTO normal (v) VALUES ('kept')`);
      sql.exec(`CREATE INDEX normal_v ON normal (v)`);
      sql.exec(`CREATE VIRTUAL TABLE f USING fts5(content)`);
      sql.exec(`INSERT INTO f (content) VALUES ('indexed')`);

      const schema = readSchema(sql);
      return { schema, pages: dump(sql, findTable(schema, "normal")) };
    });

    const names = captured.schema.tables.map((table) => table.name);
    expect(names).toContain("normal");
    for (const skipped of [
      "f",
      "f_data",
      "f_idx",
      "f_content",
      "f_docsize",
      "f_config",
    ]) {
      expect(names).not.toContain(skipped);
    }
    expect(
      captured.schema.indexes.some((sql) => sql.includes("normal_v")),
    ).toBe(true);

    const target = harness("dump-fts-target");
    const readBack = await runInDurableObject(target, (_instance, state) => {
      const sql = state.storage.sql;
      createTables(sql, captured.schema);
      writePage(sql, findTable(captured.schema, "normal"), rowsOf(captured.pages));
      createIndexes(sql, captured.schema);
      return sql
        .exec<{ v: string }>(`SELECT v FROM normal`)
        .toArray()
        .map((row) => row.v);
    });

    expect(readBack).toEqual(["kept"]);
  });

  it("resumes WITHOUT ROWID tables across pages without gaps or duplicates", async () => {
    const source = harness("dump-without-rowid-pages");
    const result = await runInDurableObject(source, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE wo (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
      for (let i = 0; i < 200; i += 1) {
        sql.exec(
          `INSERT INTO wo (k, v) VALUES (?, ?)`,
          `k${String(i).padStart(3, "0")}`,
          `v${i}`,
        );
      }
      const table = findTable(readSchema(sql), "wo");
      const pages: number[] = [];
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10_000; i += 1) {
        const page = readPage(sql, table, cursor, 2000);
        pages.push(page.rows.length);
        for (const row of page.rows) seen.push(row.k as string);
        cursor = page.next;
        if (cursor === null) break;
      }
      return { pages, seen };
    });

    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.seen).toHaveLength(200);
    expect(new Set(result.seen).size).toBe(200);
    expect(result.seen).toEqual(
      Array.from(
        { length: 200 },
        (_value, i) => `k${String(i).padStart(3, "0")}`,
      ),
    );
  });

  it("pages by size and resumes from the cursor", async () => {
    const source = harness("dump-pages");
    const result = await runInDurableObject(source, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE big (id INTEGER PRIMARY KEY, body TEXT)`);
      const body = "x".repeat(10 * 1024);
      for (let id = 1; id <= 300; id += 1) {
        sql.exec(`INSERT INTO big (id, body) VALUES (?, ?)`, id, body);
      }
      const table = findTable(readSchema(sql), "big");
      const pages: number[] = [];
      const seen = new Set<number>();
      let cursor: string | null = null;
      for (let i = 0; i < 10_000; i += 1) {
        const page = readPage(sql, table, cursor, PAGE_BYTES);
        pages.push(page.rows.length);
        for (const row of page.rows) seen.add(row.id as number);
        cursor = page.next;
        if (cursor === null) break;
      }
      return { pages, total: seen.size };
    });

    expect(result.pages[0]).toBeLessThan(300);
    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.total).toBe(300);
  });

  it("returns an oversize row alone on its own page", async () => {
    const source = harness("dump-oversize");
    const page = await runInDurableObject(source, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE huge (id INTEGER PRIMARY KEY, body TEXT)`);
      sql.exec(
        `INSERT INTO huge (id, body) VALUES (1, ?)`,
        "x".repeat(2 << 20),
      );
      const table = findTable(readSchema(sql), "huge");
      return readPage(sql, table, null, PAGE_BYTES);
    });

    expect(page.rows.length).toBe(1);
    expect(page.next).toBeNull();
  });

  it("returns an empty page for an empty table", async () => {
    const source = harness("dump-empty");
    const page = await runInDurableObject(source, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE empty (id INTEGER PRIMARY KEY, v TEXT)`);
      const table = findTable(readSchema(sql), "empty");
      return readPage(sql, table, null);
    });

    expect(page).toEqual({ rows: [], next: null });
  });
});
