/**
 * Generic, business-agnostic SQLite dump and restore helpers.
 *
 * A dump row is a plain JSON object. Values are read through SQLite
 * `quote()` so every value survives the trip through JSON: TEXT stays a
 * string, BLOB becomes `{ $blob: <base64> }`, REAL becomes
 * `{ $real: <quote text> }` and integers outside the JS safe range become
 * `{ $int: <decimal> }`. A plain JSON number always means INTEGER. Rowid
 * tables also carry `__rowid`.
 */

export const PAGE_BYTES = 1 << 20;
export const EXCLUDED_TABLES = ["admin_maintenance"] as const;

export type DumpValue =
  | string
  | number
  | null
  | { $int: string }
  | { $real: string }
  | { $blob: string };

export type DumpRow = Record<string, DumpValue>;

export type TableSchema = {
  name: string;
  create: string;
  withoutRowid: boolean;
};

export type DbSchema = { tables: TableSchema[]; indexes: string[] };

export type DumpPage = { rows: DumpRow[]; next: string | null };

/** Rows fetched from SQLite per query; a page may need several batches. */
const ROW_BATCH = 500;

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_INDEX: Record<string, number> = Object.fromEntries(
  [...BASE64_ALPHABET].map((char, index) => [char, index]),
);

type ColumnInfo = { name: string; pk: number };

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const VIRTUAL_TABLE = /^\s*CREATE\s+VIRTUAL\s+TABLE/i;

/** Shadow tables SQLite creates for each FTS5 virtual table. */
const FTS_SHADOW_SUFFIXES = [
  "_data",
  "_idx",
  "_content",
  "_docsize",
  "_config",
] as const;

function isExcludedTable(name: string): boolean {
  return (
    name.startsWith("sqlite_") ||
    name.startsWith("_cf_") ||
    (EXCLUDED_TABLES as readonly string[]).includes(name)
  );
}

function columns(sql: SqlStorage, table: string): ColumnInfo[] {
  return sql
    .exec<ColumnInfo>(
      `PRAGMA table_info(${quoteIdent(table)})`,
    )
    .toArray()
    .map(({ name, pk }) => ({ name, pk }));
}

function hasRowid(sql: SqlStorage, table: string): boolean {
  try {
    sql.exec(`SELECT rowid FROM ${quoteIdent(table)} LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

export function readSchema(sql: SqlStorage): DbSchema {
  const allTables = sql
    .exec<{ name: string; sql: string | null }>(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    )
    .toArray();

  // FTS indexes are derived data: the Agents SDK rebuilds them lazily from the
  // source rows, and SQLite rejects writing their shadow tables directly.
  const skipped = new Set<string>();
  for (const row of allTables) {
    if (row.sql === null || !VIRTUAL_TABLE.test(row.sql)) continue;
    skipped.add(row.name);
    for (const suffix of FTS_SHADOW_SUFFIXES) {
      skipped.add(`${row.name}${suffix}`);
    }
  }

  const tables = allTables
    .filter(
      (row) =>
        row.sql !== null &&
        !isExcludedTable(row.name) &&
        !skipped.has(row.name),
    )
    .map((row) => ({
      name: row.name,
      create: row.sql!,
      withoutRowid: !hasRowid(sql, row.name),
    }));
  const indexes = sql
    .exec<{ tbl_name: string; sql: string | null }>(
      `SELECT tbl_name, sql FROM sqlite_master
       WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`,
    )
    .toArray()
    .filter(
      (row) =>
        !isExcludedTable(row.tbl_name) && !skipped.has(row.tbl_name),
    )
    .map((row) => row.sql!);
  return { tables, indexes };
}

function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytesToBase64(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      BASE64_ALPHABET[n & 63]!;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i]! << 16;
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      "==";
  } else if (remaining === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      "=";
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/g, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const value = BASE64_INDEX[clean[i]!];
    if (value === undefined) throw new Error(`invalid base64: ${text}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (buffer >> bits) & 0xff;
      index += 1;
      buffer &= (1 << bits) - 1;
    }
  }
  return out.slice(0, index);
}

function decodeValue(text: string): DumpValue {
  if (text === "NULL") return null;
  if (text.startsWith("X'")) {
    return { $blob: hexToBase64(text.slice(2, -1)) };
  }
  if (text.startsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/[.eE]/.test(text)) return { $real: text };
  const value = Number(text);
  if (Number.isSafeInteger(value)) return value;
  return { $int: text };
}

function decodeRow(
  raw: Record<string, SqlStorageValue>,
  cols: ColumnInfo[],
  withRowid: boolean,
): DumpRow {
  const row: DumpRow = {};
  if (withRowid) row.__rowid = decodeValue(String(raw.__rowid));
  for (const column of cols) {
    row[column.name] = decodeValue(String(raw[column.name]));
  }
  return row;
}

function encodeRowid(value: DumpValue | undefined): string {
  if (value !== null && typeof value === "object" && "$int" in value) {
    return value.$int;
  }
  return String(value);
}

export function readPage(
  sql: SqlStorage,
  table: TableSchema,
  cursor: string | null,
  maxBytes: number = PAGE_BYTES,
): DumpPage {
  const cols = columns(sql, table.name);
  const select = cols
    .map(
      (column) =>
        `quote(${quoteIdent(column.name)}) AS ${quoteIdent(column.name)}`,
    )
    .join(", ");

  const rows: DumpRow[] = [];
  let bytes = 0;

  if (table.withoutRowid) {
    const primaryKey = cols
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => quoteIdent(column.name))
      .join(", ");
    let offset = cursor === null ? 0 : Number(cursor);
    for (;;) {
      const batch = sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT ${select} FROM ${quoteIdent(table.name)}
           ORDER BY ${primaryKey} LIMIT ? OFFSET ?`,
          ROW_BATCH,
          offset,
        )
        .toArray();
      if (batch.length === 0) return { rows, next: null };

      for (let i = 0; i < batch.length; i += 1) {
        const row = decodeRow(batch[i]!, cols, false);
        const size = JSON.stringify(row).length;
        if (rows.length > 0 && bytes + size > maxBytes) {
          return { rows, next: String(offset + i) };
        }
        rows.push(row);
        bytes += size;
      }
      offset += batch.length;
      if (batch.length < ROW_BATCH) return { rows, next: null };
    }
  }

  let position = cursor;
  for (;;) {
    const batch =
      position === null
        ? sql
            .exec<Record<string, SqlStorageValue>>(
              `SELECT quote(rowid) AS __rowid, ${select}
               FROM ${quoteIdent(table.name)} ORDER BY rowid LIMIT ?`,
              ROW_BATCH,
            )
            .toArray()
        : sql
            .exec<Record<string, SqlStorageValue>>(
              `SELECT quote(rowid) AS __rowid, ${select}
               FROM ${quoteIdent(table.name)}
               WHERE rowid > CAST(? AS INTEGER) ORDER BY rowid LIMIT ?`,
              position,
              ROW_BATCH,
            )
            .toArray();
    if (batch.length === 0) return { rows, next: null };

    for (let i = 0; i < batch.length; i += 1) {
      const row = decodeRow(batch[i]!, cols, true);
      const size = JSON.stringify(row).length;
      if (rows.length > 0 && bytes + size > maxBytes) {
        return { rows, next: position };
      }
      rows.push(row);
      bytes += size;
      position = encodeRowid(row.__rowid);
    }
    if (batch.length < ROW_BATCH) return { rows, next: null };
  }
}

function bindValue(value: DumpValue): {
  placeholder: string;
  binding: SqlStorageValue;
} {
  if (value !== null && typeof value === "object") {
    if ("$int" in value) {
      return { placeholder: "CAST(? AS INTEGER)", binding: value.$int };
    }
    if ("$real" in value) {
      return { placeholder: "CAST(? AS REAL)", binding: value.$real };
    }
    return {
      placeholder: "?",
      binding: base64ToBytes(value.$blob).buffer as ArrayBuffer,
    };
  }
  // A JSON number always means INTEGER: a bare number binding would be
  // stored as REAL inside an untyped or BLOB-affinity column.
  if (typeof value === "number") {
    return { placeholder: "CAST(? AS INTEGER)", binding: value };
  }
  return { placeholder: "?", binding: value };
}

export function createTables(sql: SqlStorage, schema: DbSchema): void {
  const existing = new Set(
    sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table'`,
      )
      .toArray()
      .map((row) => row.name),
  );
  for (const table of schema.tables) {
    if (table.create === "" || existing.has(table.name)) continue;
    sql.exec(table.create);
    existing.add(table.name);
  }
}

export function writePage(
  sql: SqlStorage,
  table: TableSchema,
  rows: DumpRow[],
): void {
  const cols = columns(sql, table.name);
  const names = table.withoutRowid
    ? cols.map((column) => column.name)
    : ["rowid", ...cols.map((column) => column.name)];
  const prefix = `INSERT INTO ${quoteIdent(table.name)} (${names
    .map(quoteIdent)
    .join(", ")}) VALUES (`;

  for (const row of rows) {
    const placeholders: string[] = [];
    const bindings: SqlStorageValue[] = [];
    const push = (value: DumpValue) => {
      const { placeholder, binding } = bindValue(value);
      placeholders.push(placeholder);
      bindings.push(binding);
    };

    if (!table.withoutRowid) push(row.__rowid ?? null);
    for (const column of cols) push(row[column.name] ?? null);
    sql.exec(`${prefix}${placeholders.join(", ")})`, ...bindings);
  }
}

const INDEX_NAME =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|'(?:[^']|'')*'|[^\s(]+)/i;

function indexName(statement: string): string | null {
  const match = INDEX_NAME.exec(statement);
  if (!match) return null;
  const raw = match[1]!;
  if (raw.startsWith('"')) return raw.slice(1, -1).replace(/""/g, '"');
  if (raw.startsWith("`")) return raw.slice(1, -1).replace(/``/g, "`");
  if (raw.startsWith("[")) return raw.slice(1, -1);
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

export function createIndexes(sql: SqlStorage, schema: DbSchema): void {
  const existing = new Set(
    sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index'`,
      )
      .toArray()
      .map((row) => row.name),
  );
  for (const statement of schema.indexes) {
    const name = indexName(statement);
    if (name !== null && existing.has(name)) continue;
    sql.exec(statement);
    if (name !== null) existing.add(name);
  }
}
