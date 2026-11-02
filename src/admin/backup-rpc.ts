/**
 * Backup/restore RPC implementation shared by the three Durable Object kinds.
 *
 * The methods are composed into `ButlerDO`, `TaskDO` and `ChannelDO`; they
 * depend only on `DurableObjectState` and the optional maintenance lease, so
 * they never touch business code or the Agents SDK. That matters after
 * `deleteAll`: the SDK tables are gone, but these RPCs keep working because
 * they only use raw SQL and KV.
 */

import type { MaintenanceStore } from "./maintenance";
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
} from "./sql-dump";

/** Pseudo-table for the object's KV storage; it has no SQL schema. */
export const KV_TABLE: TableSchema = {
  name: "__kv",
  create: "",
  withoutRowid: true,
};

/**
 * Keys fetched per KV page and written per `put()` call. Durable Object KV
 * accepts at most 128 entries in a single `put()`.
 */
const KV_PAGE_LIMIT = 128;

export class BackupRpc {
  private readonly ctx: DurableObjectState;

  private readonly lease: MaintenanceStore | null;

  constructor(ctx: DurableObjectState, lease: MaintenanceStore | null) {
    this.ctx = ctx;
    this.lease = lease;
  }

  backupSchema(): DbSchema {
    const schema = readSchema(this.ctx.storage.sql);
    return { tables: [...schema.tables, KV_TABLE], indexes: schema.indexes };
  }

  async backupPage(
    table: TableSchema,
    cursor: string | null,
  ): Promise<DumpPage> {
    if (table.name === KV_TABLE.name) return this.readKvPage(cursor);
    return readPage(this.ctx.storage.sql, table, cursor);
  }

  async restoreBegin(schema: DbSchema): Promise<void> {
    // `deleteAll` removes the lease table too. Capture the live lease first so
    // the next admin request still sees it and the restore can continue.
    const lease = this.lease?.current() ?? null;
    await this.ctx.storage.deleteAll();
    if (this.lease && lease !== null) this.lease.restore(lease);
    createTables(this.ctx.storage.sql, schema);
  }

  async restorePage(table: TableSchema, rows: DumpRow[]): Promise<void> {
    if (table.name === KV_TABLE.name) {
      for (let start = 0; start < rows.length; start += KV_PAGE_LIMIT) {
        const entries = rows
          .slice(start, start + KV_PAGE_LIMIT)
          .map((row) => [String(row.key), JSON.parse(String(row.value))]);
        await this.ctx.storage.put(Object.fromEntries(entries));
      }
      return;
    }
    this.ctx.storage.transactionSync(() =>
      writePage(this.ctx.storage.sql, table, rows),
    );
  }

  async restoreCommit(schema: DbSchema): Promise<void> {
    createIndexes(this.ctx.storage.sql, schema);
    // Wake the object once the tables are in place: the Agents SDK reschedules
    // its callbacks and Pi re-attaches to a session from storage.
    await this.ctx.storage.setAlarm(Date.now());
  }

  restoreReset(): void {
    // The instance caches restored-over state in memory (Pi sessions, the
    // Agents SDK schedule queue). Abort it so the next request reconstructs.
    this.ctx.abort("data restored");
  }

  private async readKvPage(cursor: string | null): Promise<DumpPage> {
    const entries = await this.ctx.storage.list({
      ...(cursor === null ? {} : { startAfter: cursor }),
      limit: KV_PAGE_LIMIT,
    });
    const rows: DumpRow[] = [];
    let bytes = 0;
    let last = cursor;
    for (const [key, value] of entries) {
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(value);
      } catch {
        encoded = undefined;
      }
      if (encoded === undefined) {
        throw new Error(`KV value not serializable: ${key}`);
      }

      const row: DumpRow = { key, value: encoded };
      const size = JSON.stringify(row).length;
      if (rows.length > 0 && bytes + size > PAGE_BYTES) {
        return { rows, next: last };
      }
      rows.push(row);
      bytes += size;
      last = key;
    }
    return {
      rows,
      next: entries.size < KV_PAGE_LIMIT ? null : last,
    };
  }
}
