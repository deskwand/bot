import type { ToolRegistration } from "@earendil-works/pi-durable";
import { t, type Locale } from "../i18n";
export const SELF_WAKE_PREFIX = "self-wake:";
export function isSelfWake(operationId: string): boolean {
  return operationId.startsWith(SELF_WAKE_PREFIX);
}
export type SelfWakeState = {
  generation: number;
  at: number | null;
  retryAt: number | null;
  day: string;
  reserved: number;
};
export class SelfWakeStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS butler_self_wake (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL DEFAULT 0, at INTEGER, retry_at INTEGER, day TEXT NOT NULL DEFAULT '', reserved INTEGER NOT NULL DEFAULT 0)`,
    );
    sql.exec("INSERT OR IGNORE INTO butler_self_wake(id) VALUES(1)");
  }
  get(): SelfWakeState {
    return this.sql
      .exec<SelfWakeState>(
        "SELECT generation,at,retry_at AS retryAt,day,reserved FROM butler_self_wake WHERE id=1",
      )
      .one();
  }
  set(at: number | null, now: number): SelfWakeState {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      (at !== null && (!Number.isSafeInteger(at) || at < 0))
    )
      throw new RangeError("invalid wake time");
    this.sql.exec(
      "UPDATE butler_self_wake SET generation=generation+1,at=?,retry_at=NULL WHERE id=1",
      at,
    );
    return this.get();
  }
  reserve(generation: number, now: number): boolean {
    const day = new Date(now).toISOString().slice(0, 10);
    return (
      this.sql.exec(
        `UPDATE butler_self_wake SET day=?,reserved=CASE WHEN day=? THEN reserved+1 ELSE 1 END
   WHERE id=1 AND generation=? AND at IS NOT NULL AND at<=? AND (retry_at IS NULL OR retry_at<=?) AND (day<>? OR reserved<48)`,
        day,
        day,
        generation,
        now,
        now,
        day,
      ).rowsWritten > 0
    );
  }
  refund(day: string): void {
    this.sql.exec(
      "UPDATE butler_self_wake SET reserved=reserved-1 WHERE id=1 AND day=? AND reserved>0",
      day,
    );
  }
  clearIfGeneration(generation: number): void {
    this.sql.exec(
      "UPDATE butler_self_wake SET at=NULL,retry_at=NULL WHERE id=1 AND generation=?",
      generation,
    );
  }
  deferIfGeneration(generation: number, retryAt: number): void {
    this.sql.exec(
      "UPDATE butler_self_wake SET retry_at=? WHERE id=1 AND generation=? AND at IS NOT NULL",
      retryAt,
      generation,
    );
  }
  rearmInterrupted(generation: number, retryAt: number): boolean {
    return (
      this.sql.exec(
        "UPDATE butler_self_wake SET generation=generation+1,at=?,retry_at=NULL WHERE id=1 AND generation=? AND at IS NOT NULL",
        retryAt,
        generation,
      ).rowsWritten > 0
    );
  }
}
const ALLOWED = new Set([
  "read_self",
  "write_self",
  "record_experience",
  "now",
  "quick_lookup",
  "list_tasks",
  "get_task",
  "list_schedules",
  "set_self_wake",
  "notify_owner",
]);
/** Check durable running input on every call, including after isolate recovery. */
export function guardSelfTool(
  tool: ToolRegistration,
  active: () => Promise<boolean>,
  locale: Locale,
): ToolRegistration {
  return {
    ...tool,
    async execute(...args) {
      try {
        if ((await active()) && !ALLOWED.has(tool.name))
          return {
            isError: true,
            output: [{ type: "text", text: t(locale, "butler.self.denied") }],
          };
      } catch {
        return {
          isError: true,
          output: [{ type: "text", text: t(locale, "butler.self.denied") }],
        };
      }
      return tool.execute.apply(tool, args);
    },
  };
}
