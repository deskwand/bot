import { DurableObject } from "cloudflare:workers";

/** Largest object the local store accepts; the product caps artifacts at 15 MB. */
export const STORE_MAX_BYTES = 16 * 1024 * 1024;

/** Each SQLite row holds at most this many bytes of an object. */
export const CHUNK_BYTES = 1024 * 1024;

/** Default and maximum page size for `list`. */
const LIST_LIMIT = 1000;

export type StoredMeta = {
  key: string;
  size: number;
  uploadedMs: number;
  contentType: string | null;
};

type ObjectRow = {
  key: string;
  size: number;
  content_type: string | null;
  uploaded_ms: number;
};

type ChunkRow = { seq: number; data: ArrayBuffer };

const CREATE_OBJECTS = `
  CREATE TABLE IF NOT EXISTS objects(
    key TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    content_type TEXT,
    uploaded_ms INTEGER NOT NULL
  )
`;

const CREATE_CHUNKS = `
  CREATE TABLE IF NOT EXISTS chunks(
    key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY(key, seq)
  )
`;

function toStoredMeta(row: ObjectRow): StoredMeta {
  return {
    key: row.key,
    size: row.size,
    uploadedMs: row.uploaded_ms,
    contentType: row.content_type,
  };
}

/** The smallest string strictly above every key starting with `prefix`. */
function prefixUpperBound(prefix: string): string | undefined {
  if (prefix === "") return undefined;
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/**
 * R2-compatible artifact storage for container deployments. Objects are split
 * into 1 MiB rows so range reads only touch the chunks they cover.
 */
export class StoreDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(CREATE_OBJECTS);
    ctx.storage.sql.exec(CREATE_CHUNKS);
  }

  head(key: string): StoredMeta | null {
    const row = this.ctx.storage.sql
      .exec<ObjectRow>(
        "SELECT key, size, content_type, uploaded_ms FROM objects WHERE key = ?",
        key,
      )
      .toArray()[0];
    return row === undefined ? null : toStoredMeta(row);
  }

  get(
    key: string,
    range?: { offset: number; length: number },
  ): { meta: StoredMeta; bytes: Uint8Array } | null {
    const meta = this.head(key);
    if (meta === null) return null;

    const start = range === undefined ? 0 : Math.max(0, range.offset);
    const length = range === undefined ? meta.size : Math.max(0, range.length);
    const end = Math.min(meta.size, start + length);
    return { meta, bytes: this.readRange(key, start, end) };
  }

  put(key: string, bytes: Uint8Array, contentType: string | null): void {
    if (bytes.byteLength > STORE_MAX_BYTES) {
      throw new RangeError(
        `object is ${bytes.byteLength} bytes, limit is ${STORE_MAX_BYTES}`,
      );
    }
    const uploadedMs = Date.now();

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM chunks WHERE key = ?", key);
      let seq = 0;
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
        this.ctx.storage.sql.exec(
          "INSERT INTO chunks (key, seq, data) VALUES (?, ?, ?)",
          key,
          seq,
          new Uint8Array(chunk),
        );
        seq++;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO objects (key, size, content_type, uploaded_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           size = excluded.size,
           content_type = excluded.content_type,
           uploaded_ms = excluded.uploaded_ms`,
        key,
        bytes.byteLength,
        contentType,
        uploadedMs,
      );
    });
  }

  delete(keys: string[]): void {
    this.ctx.storage.transactionSync(() => {
      for (const key of keys) {
        this.ctx.storage.sql.exec("DELETE FROM chunks WHERE key = ?", key);
        this.ctx.storage.sql.exec("DELETE FROM objects WHERE key = ?", key);
      }
    });
  }

  list(options: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): { objects: StoredMeta[]; cursor: string | null } {
    const limit = Math.min(Math.max(options.limit ?? LIST_LIMIT, 1), LIST_LIMIT);
    const prefix = options.prefix ?? "";
    const params: (string | number)[] = [prefix];
    // Range comparison keeps `_` and `%` literal, unlike LIKE.
    let query =
      "SELECT key, size, content_type, uploaded_ms FROM objects WHERE key >= ?";
    const upper = prefixUpperBound(prefix);
    if (upper !== undefined) {
      query += " AND key < ?";
      params.push(upper);
    }
    if (options.cursor !== undefined) {
      query += " AND key > ?";
      params.push(options.cursor);
    }
    query += " ORDER BY key LIMIT ?";
    params.push(limit + 1);

    const rows = this.ctx.storage.sql.exec<ObjectRow>(query, ...params).toArray();
    const page = rows.slice(0, limit).map(toStoredMeta);
    return {
      objects: page,
      cursor: rows.length > limit ? page[page.length - 1]!.key : null,
    };
  }

  private readRange(key: string, start: number, end: number): Uint8Array {
    if (end <= start) return new Uint8Array(0);

    const firstSeq = Math.floor(start / CHUNK_BYTES);
    const lastSeq = Math.floor((end - 1) / CHUNK_BYTES);
    const rows = this.ctx.storage.sql
      .exec<ChunkRow>(
        `SELECT seq, data FROM chunks
         WHERE key = ? AND seq BETWEEN ? AND ? ORDER BY seq`,
        key,
        firstSeq,
        lastSeq,
      )
      .toArray();

    const bytes = new Uint8Array(end - start);
    for (const row of rows) {
      const chunk = new Uint8Array(row.data);
      const chunkStart = row.seq * CHUNK_BYTES;
      const from = Math.max(start - chunkStart, 0);
      const to = Math.min(end - chunkStart, chunk.length);
      if (to <= from) continue;
      bytes.set(chunk.subarray(from, to), chunkStart + from - start);
    }
    return bytes;
  }
}
