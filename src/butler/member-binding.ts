/**
 * The one identity a member's Butler object may ever act for.
 *
 * The binding is written only by `initializeMember`, after the actor was
 * proven against the channel directory and against this object's own address.
 * It lives in the object's own `meta` table, so a rebuilt object reads it back
 * instead of trusting anything a message carried, and it is never overwritten:
 * a second write with a different member id, role or epoch is denied.
 */
import { MEMBER_ACCESS_DENIED, MemberError } from "../members/store";

const BINDING_KEY = "member_binding";

export type MemberBinding = {
  memberId: string;
  role: "member";
  epoch: number;
};

/** Reads a stored row, treating anything malformed as "no binding". */
function parse(raw: string): MemberBinding | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.memberId !== "string" || row.memberId.length === 0) {
    return null;
  }
  if (row.role !== "member") return null;
  if (typeof row.epoch !== "number" || !Number.isInteger(row.epoch)) {
    return null;
  }
  return { memberId: row.memberId, role: "member", epoch: row.epoch };
}

/**
 * The Butler object name carries the identity: `member:<id>` for a member's
 * own Butler, anything else for the owner's (production only ever addresses
 * the two forms `butlerName` derives). A member object therefore cannot be
 * reached under an unnamespaced id, and an unnamespaced object is never a
 * member.
 */
export function memberIdOfButlerName(name: string): string | null {
  const prefix = "member:";
  return name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

export class MemberBindingStore {
  constructor(private readonly sql: SqlStorage) {}

  /** The persisted binding, or null when this object was never initialised. */
  get(): MemberBinding | null {
    const row = this.sql
      .exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = ?`,
        BINDING_KEY,
      )
      .toArray()[0];
    return row === undefined ? null : parse(row.value);
  }

  /**
   * First write wins. Re-initialising with the same identity is idempotent;
   * a different member id, role or epoch is a denial, never an overwrite.
   */
  put(binding: MemberBinding): MemberBinding {
    const existing = this.get();
    if (existing !== null) {
      if (
        existing.memberId !== binding.memberId ||
        existing.role !== binding.role ||
        existing.epoch !== binding.epoch
      ) {
        throw new MemberError(MEMBER_ACCESS_DENIED);
      }
      return existing;
    }
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO NOTHING`,
      BINDING_KEY,
      JSON.stringify(binding),
    );
    const stored = this.get();
    // A concurrent writer or a storage fault must not hand out an unverified
    // identity: read back and refuse anything that does not match.
    if (stored === null || stored.memberId !== binding.memberId) {
      throw new MemberError(MEMBER_ACCESS_DENIED);
    }
    return stored;
  }
}
