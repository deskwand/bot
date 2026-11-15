import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SelfStore } from "../../src/butler/self-store";
const run = (name: string, fn: (store: SelfStore, sql: SqlStorage) => void) =>
  runInDurableObject(
    env.BUTLER.get(env.BUTLER.idFromName(`self-store-${name}`)),
    (_i, s) => fn(new SelfStore(s.storage.sql), s.storage.sql),
  );
const event = (id = "e1", facts = "observed") => ({
  id,
  facts,
  interpretation: "uncertain",
  source: { kind: "task" as const, ref: "t1", excerpt: "result" },
  occurredAt: 0,
});
describe("SelfStore", () => {
  it("uses atomic version checks and preserves all revisions", () =>
    run("cas", (s) => {
      expect(s.doc("identity")).toEqual({
        kind: "identity",
        version: 0,
        content: "",
      });
      expect(s.writeDoc("identity", "verify first", 0, 1).ok).toBe(true);
      expect(s.writeDoc("identity", "stale", 0, 2)).toMatchObject({
        ok: false,
        reason: "conflict",
        current: { version: 1 },
      });
      expect(s.doc("identity").content).toBe("verify first");
      expect(s.writeDoc("identity", "🙂".repeat(1200), 1, 3).ok).toBe(true);
      for (const content of ["🙂".repeat(1201), ">>>", "<<<"])
        expect(s.writeDoc("identity", content, 2, 4).ok).toBe(false);
      expect(s.writeDoc("situation", "x".repeat(601), 0, 5).ok).toBe(false);
      expect(s.writeDoc("identity", "bad", -1, 1).ok).toBe(false);
      expect(s.writeDoc("identity", "bad", 2, NaN).ok).toBe(false);
      expect(s.read({ kind: "identity", history: true }).records).toHaveLength(
        2,
      );
    }));
  it("revises experiences without resurrecting stale search or cursor matches", () =>
    run("latest", (s) => {
      expect(s.recordExperience(event(), 0, 1).ok).toBe(true);
      expect(s.recordExperience(event("e1", "corrected"), 1, 2).ok).toBe(true);
      expect(s.recentExperiences()).toHaveLength(1);
      expect(
        s.read({ kind: "experience", id: "e1", history: true }).records,
      ).toHaveLength(2);
      expect(
        s.read({ kind: "experience", keyword: "observed" }).records,
      ).toEqual([]);
      expect(s.read({ kind: "experience", before: 2 }).records).toEqual([]);
      expect(s.recordExperience(event("e2"), 1, 3)).toMatchObject({
        reason: "conflict",
        current: null,
      });
      expect(s.recordExperience(event("e3", "x".repeat(601)), 0, 3).ok).toBe(
        false,
      );
      expect(
        s.recordExperience(
          { ...event("e4"), interpretation: "x".repeat(601) },
          0,
          3,
        ).ok,
      ).toBe(false);
      expect(
        s.recordExperience(
          {
            ...event("e5"),
            source: { kind: "reflection", ref: null, excerpt: "" },
          },
          0,
          3,
        ).ok,
      ).toBe(false);
      expect(() => s.read({ kind: "experience", history: true })).toThrow(
        RangeError,
      );
      expect(() => s.read({ kind: "identity", keyword: "x" })).toThrow(
        RangeError,
      );
    }));
  it("paginates without gaps and treats wildcard searches literally", () =>
    run("pages", (s) => {
      for (let i = 0; i < 21; i++)
        s.recordExperience(
          event(`e${i}`, i === 0 ? "100%_done" : "normal"),
          0,
          i,
        );
      const a = s.read({ kind: "experience" });
      const b = s.read({ kind: "experience", before: a.nextBefore! });
      expect(a.records).toHaveLength(20);
      expect(b.records).toHaveLength(1);
      expect(b.nextBefore).toBeNull();
      expect(
        new Set(
          [...a.records, ...b.records].map((r) => ("id" in r ? r.id : "")),
        ).size,
      ).toBe(21);
      expect(
        s.read({ kind: "experience", keyword: "%_" }).records,
      ).toHaveLength(1);
    }));
  it("preserves the old value when SQL refuses a write", () =>
    run("failure", (s, sql) => {
      s.writeDoc("identity", "kept", 0, 1);
      sql.exec(
        "CREATE TRIGGER reject_self BEFORE INSERT ON butler_self_records BEGIN SELECT RAISE(ABORT, 'test failure'); END",
      );
      expect(() => s.writeDoc("identity", "lost", 1, 2)).toThrow();
      expect(s.doc("identity").content).toBe("kept");
    }));
});
