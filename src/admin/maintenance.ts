/**
 * Maintenance lease shared by every backup/restore admin request.
 *
 * The lease lives in its own single-row table so a dump never carries it:
 * restoring a backup must not resurrect an expired lease or collide with the
 * one the current restore acquired. Keeping the row after `deleteAll` is the
 * caller's job (`restore`).
 */

export const LEASE_MS = 600_000;
export const DEFER_MS = 60_000;

export type Lease = {
  until: number;
  op: "export" | "restore";
  opId: string;
};

type LeaseRow = {
  until: number;
  op: string;
  op_id: string;
};

export class MaintenanceStore {
  private readonly sql: SqlStorage;

  private readonly now: () => number;

  constructor(sql: SqlStorage, now: () => number = Date.now) {
    this.sql = sql;
    this.now = now;
  }

  /** The live lease, or null when absent or expired. */
  current(): Lease | null {
    const lease = this.read();
    if (lease === null) return null;
    return lease.until > this.now() ? lease : null;
  }

  /** Takes or extends the lease; a different live opId makes it busy. */
  acquire(op: Lease["op"], opId: string): Lease | "busy" {
    const lease = this.current();
    if (lease !== null && lease.opId !== opId) return "busy";

    const next: Lease = { until: this.now() + LEASE_MS, op, opId };
    this.write(next);
    return next;
  }

  /** Extends only the matching lease and only while it is still live. */
  renew(opId: string): boolean {
    const lease = this.current();
    if (lease === null || lease.opId !== opId) return false;
    this.write({ ...lease, until: this.now() + LEASE_MS });
    return true;
  }

  /** Deletes the row only when the opId matches, live or expired. */
  release(opId: string): void {
    this.ensureTable();
    this.sql.exec(
      `DELETE FROM admin_maintenance WHERE singleton = 1 AND op_id = ?`,
      opId,
    );
  }

  /** Recreates the table after `deleteAll` and writes the lease back. */
  restore(lease: Lease): void {
    this.write(lease);
  }

  private read(): Lease | null {
    this.ensureTable();
    const row = this.sql
      .exec<LeaseRow>(
        `SELECT until, op, op_id FROM admin_maintenance WHERE singleton = 1`,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      until: row.until,
      op: row.op as Lease["op"],
      opId: row.op_id,
    };
  }

  private write(lease: Lease): void {
    this.ensureTable();
    this.sql.exec(
      `INSERT INTO admin_maintenance (singleton, until, op, op_id)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         until = excluded.until,
         op = excluded.op,
         op_id = excluded.op_id`,
      lease.until,
      lease.op,
      lease.opId,
    );
  }

  private ensureTable(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS admin_maintenance (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        until INTEGER NOT NULL,
        op TEXT NOT NULL,
        op_id TEXT NOT NULL
      )`,
    );
  }
}
