export type SelfDocKind = "identity" | "situation";
export type ExperienceSource = {
  kind: "owner_message" | "task" | "bot" | "observation" | "reflection";
  ref: string | null;
  excerpt: string;
};
export type SelfDoc = { kind: SelfDocKind; version: number; content: string };
export type Experience = {
  id: string;
  version: number;
  facts: string;
  interpretation: string;
  source: ExperienceSource;
  occurredAt: number;
  recordedAt: number;
};
export type SelfRecord = SelfDoc | Experience;
export type SelfWriteResult =
  | { ok: true; value: SelfRecord }
  | { ok: false; reason: "conflict"; current: SelfRecord | null }
  | { ok: false; reason: "invalid"; message: string };
export type SelfQuery = {
  kind: SelfDocKind | "experience";
  id?: string;
  keyword?: string;
  before?: number;
  history?: boolean;
  limit?: number;
};
export type SelfPage = { records: SelfRecord[]; nextBefore: number | null };
type Row = { seq: number; body_json: string };
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const text = (s: string, max: number) =>
  typeof s === "string" &&
  [...s].length <= max &&
  !s.includes("<<<") &&
  !s.includes(">>>");
const invalid = (): SelfWriteResult => ({
  ok: false,
  reason: "invalid",
  message: "invalid self record",
});

/** Append-only revisions; the conditional insert is the version compare-and-swap. */
export class SelfStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS butler_self_records (
   seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
   version INTEGER NOT NULL, body_json TEXT NOT NULL, recorded_at INTEGER NOT NULL,
   UNIQUE(kind, entity_id, version))`);
  }
  doc(kind: SelfDocKind): SelfDoc {
    if (kind !== "identity" && kind !== "situation")
      throw new RangeError("invalid kind");
    return (
      (this.current(kind, kind) as SelfDoc | null) ?? {
        kind,
        version: 0,
        content: "",
      }
    );
  }
  private current(kind: string, id: string): SelfRecord | null {
    const row = this.sql
      .exec<Row>(
        "SELECT body_json FROM butler_self_records WHERE kind=? AND entity_id=? ORDER BY version DESC LIMIT 1",
        kind,
        id,
      )
      .toArray()[0];
    return row ? JSON.parse(row.body_json) : null;
  }
  recentExperiences(limit = 3): Experience[] {
    return this.read({ kind: "experience", limit }).records as Experience[];
  }
  read(q: SelfQuery): SelfPage {
    if (
      !["identity", "situation", "experience"].includes(q.kind) ||
      (q.id !== undefined && q.kind !== "experience") ||
      (q.keyword !== undefined &&
        (q.kind !== "experience" || q.history === true)) ||
      (q.history === true && q.kind === "experience" && !q.id) ||
      (q.before !== undefined && !integer(q.before)) ||
      (q.limit !== undefined && !Number.isFinite(q.limit))
    )
      throw new RangeError("invalid self query");
    const limit = Math.max(1, Math.min(20, Math.floor(q.limit ?? 20)));
    const where = ["r.kind=?"];
    const args: (string | number)[] = [q.kind];
    if (q.kind !== "experience" || q.id) {
      where.push("r.entity_id=?");
      args.push(q.id ?? q.kind);
    }
    if (!q.history)
      where.push(
        "NOT EXISTS (SELECT 1 FROM butler_self_records n WHERE n.kind=r.kind AND n.entity_id=r.entity_id AND n.version>r.version)",
      );
    if (q.before !== undefined) {
      where.push("r.seq<?");
      args.push(q.before);
    }
    if (q.keyword) {
      where.push(
        "(json_extract(r.body_json,'$.facts') LIKE ? ESCAPE '\\' OR json_extract(r.body_json,'$.interpretation') LIKE ? ESCAPE '\\')",
      );
      const match = `%${q.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(match, match);
    }
    const rows = this.sql
      .exec<Row>(
        `SELECT r.seq,r.body_json FROM butler_self_records r WHERE ${where.join(" AND ")} ORDER BY r.seq DESC LIMIT ?`,
        ...args,
        limit + 1,
      )
      .toArray();
    return {
      records: rows.slice(0, limit).map((r) => JSON.parse(r.body_json)),
      nextBefore: rows.length > limit ? rows[limit - 1]!.seq : null,
    };
  }
  writeDoc(
    kind: SelfDocKind,
    content: string,
    expectedVersion: number,
    now: number,
  ): SelfWriteResult {
    if (
      !["identity", "situation"].includes(kind) ||
      !integer(expectedVersion) ||
      !integer(now) ||
      !text(content, kind === "identity" ? 1200 : 600)
    )
      return invalid();
    return this.insert(
      kind,
      kind,
      { kind, version: expectedVersion + 1, content },
      expectedVersion,
      now,
    );
  }
  recordExperience(
    input: Omit<Experience, "version" | "recordedAt">,
    expectedVersion: number,
    now: number,
  ): SelfWriteResult {
    const source = input.source;
    if (
      !integer(expectedVersion) ||
      !integer(now) ||
      !integer(input.occurredAt) ||
      input.occurredAt > now ||
      !/^e[\w-]+$/.test(input.id) ||
      !text(input.facts, 600) ||
      !text(input.interpretation, 600) ||
      !source ||
      !["owner_message", "task", "bot", "observation", "reflection"].includes(
        source.kind,
      ) ||
      !text(source.excerpt, 400) ||
      (source.kind === "reflection"
        ? input.facts !== "" || source.ref !== null || source.excerpt !== ""
        : typeof source.ref !== "string" ||
          source.ref.length === 0 ||
          !text(source.ref, 200))
    )
      return invalid();
    return this.insert(
      "experience",
      input.id,
      { ...input, version: expectedVersion + 1, recordedAt: now },
      expectedVersion,
      now,
    );
  }
  private insert(
    kind: string,
    id: string,
    value: SelfRecord,
    version: number,
    now: number,
  ): SelfWriteResult {
    const cursor = this.sql.exec(
      `INSERT INTO butler_self_records(kind,entity_id,version,body_json,recorded_at)
   SELECT ?,?,?+1,?,? WHERE COALESCE((SELECT MAX(version) FROM butler_self_records WHERE kind=? AND entity_id=?),0)=?`,
      kind,
      id,
      version,
      JSON.stringify(value),
      now,
      kind,
      id,
      version,
    );
    return cursor.rowsWritten > 0
      ? { ok: true, value }
      : { ok: false, reason: "conflict", current: this.current(kind, id) };
  }
}
