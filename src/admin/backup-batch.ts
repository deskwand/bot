import type { DumpPage, DumpRow, TableSchema } from "./sql-dump";

/** Default byte budget of one chunked backup response. */
export const CHUNK_BYTES = 4 << 20;

/** Upper bound the Worker accepts, so one response stays reasonable. */
export const MAX_CHUNK_BYTES = 16 << 20;

/**
 * Tables read in one request. Each table is a Durable Object RPC, so this caps
 * the subrequests one chunk request spends.
 */
export const MAX_TABLES_PER_BATCH = 64;

/** Where the next request starts: a table index plus that table's cursor. */
export type BatchState = { index: number; cursor: string | null };

/** One table's rows inside a chunked response. */
export type BatchChunk = {
  table: string;
  rows: DumpRow[];
  next: string | null;
};

export type BatchResult = {
  chunks: BatchChunk[];
  state: BatchState;
  done: boolean;
};

/** The half of the Durable Object RPC surface the chunker needs. */
export type PageSource = {
  backupPage(table: TableSchema, cursor: string | null): Promise<DumpPage>;
};

/**
 * Reads tables in order until the byte budget is spent or every table is done.
 *
 * A table that spans pages is always the last chunk of its batch: the caller
 * keeps that table's archive entry open and appends the next chunk to it, so a
 * table never produces two entries.
 */
export async function readBatch(
  source: PageSource,
  tables: TableSchema[],
  state: BatchState,
  budgetBytes: number = CHUNK_BYTES,
): Promise<BatchResult> {
  const chunks: BatchChunk[] = [];
  let index = state.index;
  let cursor = state.cursor;
  let bytes = 0;

  while (index < tables.length && chunks.length < MAX_TABLES_PER_BATCH) {
    // Checked before reading, so a spent budget never pulls in another table.
    if (chunks.length > 0 && bytes >= budgetBytes) break;

    const table = tables[index]!;
    const page = await source.backupPage(table, cursor);
    chunks.push({ table: table.name, rows: page.rows, next: page.next });
    bytes += page.bytes;
    cursor = page.next;
    if (cursor !== null) break;
    index += 1;
  }

  return { chunks, state: { index, cursor }, done: index >= tables.length };
}
