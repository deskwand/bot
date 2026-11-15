/**
 * Which member owns which artifact key. One key belongs to exactly one
 * subject; re-registering the same owner is idempotent, a different owner is
 * refused. Unknown keys are never allowed just because the caller is owner.
 *
 * This module also owns the persisted provenance that decides whether the
 * pre-members inbox may be adopted at all: adoption is only defensible on a
 * database that provably predates members (or a v1 single-owner archive).
 */
import { OWNER_ID } from "./principal";

export const ATTACHMENT_OWNED_BY_OTHER = "ATTACHMENT_OWNED_BY_OTHER";
export const MEMBER_MIGRATION_PENDING = "MEMBER_MIGRATION_PENDING";

type OwnerRow = { member_id: string };

export class AttachmentAccess {
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS attachment_owners (
        key TEXT PRIMARY KEY,
        member_id TEXT NOT NULL
      )`,
    );
  }

  record(memberId: string, key: string): void {
    const existing = this.sql
      .exec<OwnerRow>(
        `SELECT member_id FROM attachment_owners WHERE key = ?`,
        key,
      )
      .toArray()[0];
    if (!existing) {
      this.sql.exec(
        `INSERT INTO attachment_owners (key, member_id) VALUES (?, ?)`,
        key,
        memberId,
      );
      return;
    }
    if (existing.member_id !== memberId) {
      throw new Error(ATTACHMENT_OWNED_BY_OTHER);
    }
  }

  owns(memberId: string, key: string): boolean {
    const existing = this.sql
      .exec<OwnerRow>(
        `SELECT member_id FROM attachment_owners WHERE key = ?`,
        key,
      )
      .toArray()[0];
    return existing?.member_id === memberId;
  }
}

export const LEGACY_INBOX_MIGRATION = "legacy-inbox-owner";

/** Provenance rows: `schema` (this database's origin), `archive` (restore). */
export const SCHEMA_PROVENANCE = "schema";
export const ARCHIVE_PROVENANCE = "archive";

/** The only provenance that authorizes blanket adoption of the old inbox. */
export const LEGACY_SCHEMA_V1 = "legacy-v1";
/** A database created by the members-aware schema: nothing old to adopt. */
export const FRESH_SCHEMA = "fresh";
/**
 * Members tables found without a provenance row: the database is neither
 * provably pre-members nor provably fresh, so the inbox question is denied.
 */
export const UNKNOWN_SCHEMA = "unknown";

const MIGRATION_TABLE = `CREATE TABLE IF NOT EXISTS member_migrations (
  name TEXT PRIMARY KEY,
  cursor TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)`;

const LEGACY_TABLES = ["wechat_state", "telegram_state", "owner_addresses"];

/**
 * The tables whose presence proves the members-aware schema booted here at
 * least once (they are created immediately after the provenance row).
 * Pre-members channel state can legitimately survive in a v2 database, so it
 * never decides provenance on its own once any of these exists.
 */
export const MEMBERS_AWARE_TABLES = [
  "members",
  "member_connections",
  "member_invites",
] as const;

function tableExists(sql: SqlStorage, name: string): boolean {
  // The name is a module constant, never user input. `sqlite_master` is not
  // readable through SqlStorage, so probe the table itself.
  try {
    sql.exec(`SELECT 1 FROM ${name} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

export function ensureMigrationTable(sql: SqlStorage): void {
  sql.exec(MIGRATION_TABLE);
}

function provenanceOf(sql: SqlStorage, name: string): string | null {
  ensureMigrationTable(sql);
  return (
    sql
      .exec<{ cursor: string | null }>(
        `SELECT cursor FROM member_migrations WHERE name = ?`,
        name,
      )
      .toArray()[0]?.cursor ?? null
  );
}

/**
 * Records where this database came from. Must run before the members tables
 * are created: the only evidence that a blanket adoption is safe is the
 * presence of the pre-members schema at first boot. A brand-new store is
 * `fresh`; a store with legacy channel tables and no members tables is
 * `legacy-v1`.
 *
 * Members tables without a marker mean the marker was lost or never written on
 * a database that is already multi-subject: legacy channel state cannot prove
 * anything there, so the result is `unknown` and adoption is denied. The one
 * exception stays the explicit v1 archive (see `recordArchiveVersion`).
 *
 * Idempotent: the first boot wins, later boots never rewrite the marker.
 */
export function bootstrapMemberSchema(
  sql: SqlStorage,
  now: () => number = () => Date.now(),
): string {
  const existing = provenanceOf(sql, SCHEMA_PROVENANCE);
  if (existing !== null) return existing;
  const membersAware = MEMBERS_AWARE_TABLES.some((table) =>
    tableExists(sql, table),
  );
  const legacy = LEGACY_TABLES.some((table) => tableExists(sql, table));
  const provenance = membersAware
    ? UNKNOWN_SCHEMA
    : legacy
      ? LEGACY_SCHEMA_V1
      : FRESH_SCHEMA;
  sql.exec(
    `INSERT INTO member_migrations (name, cursor, done, updated_at)
     VALUES (?, ?, 1, ?)`,
    SCHEMA_PROVENANCE,
    provenance,
    now(),
  );
  return provenance;
}

export function schemaProvenance(sql: SqlStorage): string | null {
  return provenanceOf(sql, SCHEMA_PROVENANCE);
}

/**
 * Restore provenance. Task 11 calls this with the archive's manifest version
 * as soon as a restore begins, before rows are replayed. Only a `v1` archive
 * may still be adopted; anything newer resolves the inbox migration as
 * skipped (ACL rows are expected in the archive) and reports it, so a v2
 * restore that lost ACL rows denies access instead of claiming the inbox.
 */
export function recordArchiveVersion(
  sql: SqlStorage,
  version: string,
  now: () => number = () => Date.now(),
): void {
  ensureMigrationTable(sql);
  sql.exec(
    `INSERT INTO member_migrations (name, cursor, done, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor,
       done = 1, updated_at = excluded.updated_at`,
    ARCHIVE_PROVENANCE,
    version,
    now(),
  );
}

/**
 * True once nothing about the old single-owner inbox is left to decide. A
 * fresh store has nothing to adopt; any restored or upgraded store stays
 * pending until the adoption explicitly finishes or is refused. An unknown
 * provenance is settled the same way: the migration runs, refuses to claim,
 * and only then does activation become possible.
 */
export function migrationReady(sql: SqlStorage): boolean {
  const marker = sql
    .exec<{ done: number }>(
      `SELECT done FROM member_migrations WHERE name = ?`,
      LEGACY_INBOX_MIGRATION,
    )
    .toArray()[0];
  if (marker?.done === 1) return true;
  const archive = provenanceOf(sql, ARCHIVE_PROVENANCE);
  // A v2+ archive is expected to carry its own ACL rows: nothing to adopt, so
  // the question is settled by policy rather than by a successful backfill.
  if (archive !== null) return archive !== "v1";
  return schemaProvenance(sql) === FRESH_SCHEMA;
}

function nonOwnerMembers(sql: SqlStorage): number {
  try {
    return sql
      .exec(`SELECT id FROM members WHERE role <> 'owner' LIMIT 1`)
      .toArray().length;
  } catch {
    return 0;
  }
}

export type InboxPage = { keys: string[]; cursor?: string };

export type LegacyInboxMigrationResult = {
  claimed: number;
  skipped: boolean;
  done: boolean;
  reason?: "schema" | "members" | "conflict";
};

function markSkipped(
  sql: SqlStorage,
  now: () => number,
  reason: "schema" | "members",
): LegacyInboxMigrationResult {
  sql.exec(
    `INSERT INTO member_migrations (name, cursor, done, updated_at)
     VALUES (?, NULL, 1, ?)
     ON CONFLICT(name) DO UPDATE SET done = 1, updated_at = excluded.updated_at`,
    LEGACY_INBOX_MIGRATION,
    now(),
  );
  return { claimed: 0, skipped: true, done: true, reason };
}

/**
 * One-time adoption of the pre-members inbox. It runs only when the database
 * itself says it predates members: a fresh members-aware store has nothing to
 * adopt, a v2 restore (or any restore without v1 provenance) must never claim
 * the inbox, and a database that already has members was multi-subject.
 *
 * Eligibility is revalidated after every awaited page. Member activation is
 * blocked while this is pending (`migrationReady`), so a member row appearing
 * here means the store changed under us: stop, claim nothing further, and
 * leave the migration pending rather than granting the owner more keys.
 */
export async function migrateLegacyInbox(options: {
  sql: SqlStorage;
  access: AttachmentAccess;
  list: (cursor?: string) => Promise<InboxPage>;
  memberId?: string;
  now?: () => number;
}): Promise<LegacyInboxMigrationResult> {
  const { sql, access } = options;
  const now = options.now ?? (() => Date.now());
  const memberId = options.memberId ?? OWNER_ID;
  ensureMigrationTable(sql);

  const marker = sql
    .exec<{ cursor: string | null; done: number }>(
      `SELECT cursor, done FROM member_migrations WHERE name = ?`,
      LEGACY_INBOX_MIGRATION,
    )
    .toArray()[0];
  if (marker?.done === 1) {
    return { claimed: 0, skipped: false, done: true };
  }

  const provenance = schemaProvenance(sql);
  const archive = provenanceOf(sql, ARCHIVE_PROVENANCE);
  if (
    provenance !== LEGACY_SCHEMA_V1 ||
    (archive !== null && archive !== "v1")
  ) {
    return markSkipped(sql, now, "schema");
  }
  if (nonOwnerMembers(sql) > 0) {
    return markSkipped(sql, now, "members");
  }

  let cursor = marker?.cursor ?? undefined;
  let claimed = 0;
  for (;;) {
    const page = await options.list(cursor);
    if (nonOwnerMembers(sql) > 0) {
      return { claimed, skipped: true, done: false, reason: "conflict" };
    }
    for (const key of page.keys) {
      try {
        access.record(memberId, key);
      } catch {
        return { claimed, skipped: true, done: false, reason: "conflict" };
      }
      claimed += 1;
    }
    cursor = page.cursor;
    const done = cursor === undefined ? 1 : 0;
    sql.exec(
      `INSERT INTO member_migrations (name, cursor, done, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor,
         done = excluded.done, updated_at = excluded.updated_at`,
      LEGACY_INBOX_MIGRATION,
      cursor ?? null,
      done,
      now(),
    );
    if (done === 1) break;
  }
  return { claimed, skipped: false, done: true };
}
