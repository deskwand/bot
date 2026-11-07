import { describe, expect, it } from "vitest";
import {
  STALL_AFTER_MS,
  StallWatch,
  type StallStore,
} from "../../src/task/stall";

function memoryStore(): StallStore {
  const map = new Map<string, string>();
  return {
    read: (key) => map.get(key),
    write: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("StallWatch", () => {
  it("uses a ten minute threshold", () => {
    expect(STALL_AFTER_MS).toBe(600_000);
  });

  it("is later before any activity is recorded", () => {
    const w = new StallWatch(memoryStore());
    expect(w.check(0)).toEqual({ due: "later", at: 600_000 });
  });

  it("is later before the threshold", () => {
    const w = new StallWatch(memoryStore());
    w.record({ kind: "running_tool", tool: "web_fetch" }, 0);
    expect(w.check(599_999)).toEqual({ due: "later", at: 600_000 });
  });

  it("notifies once at the threshold with the last step", () => {
    const w = new StallWatch(memoryStore());
    w.record({ kind: "running_tool", tool: "web_fetch" }, 0);
    expect(w.check(600_000)).toEqual({
      due: "notify",
      activity: { kind: "running_tool", tool: "web_fetch" },
      idleMs: 600_000,
    });
  });

  it("does not notify again for the same stall", () => {
    const w = new StallWatch(memoryStore());
    w.record({ kind: "waiting_model" }, 0);
    w.markNotified(600_000);
    expect(w.check(1_800_000)).toEqual({ due: "later", at: 2_400_000 });
    // Marking a report must not reset the clock: a restart re-arms from it.
    expect(w.activityAt()).toBe(0);
  });

  it("rearms after new activity", () => {
    const w = new StallWatch(memoryStore());
    w.record({ kind: "waiting_model" }, 0);
    w.markNotified(600_000);
    w.record({ kind: "waiting_model" }, 700_000);
    expect(w.check(1_300_000).due).toBe("notify");
  });

  it("survives a new instance over the same store", () => {
    const store = memoryStore();
    const first = new StallWatch(store);
    first.record({ kind: "running_tool", tool: "bash" }, 0);

    const second = new StallWatch(store);
    expect(second.check(600_000)).toEqual(first.check(600_000));
  });

  it("writes one row per activity event", () => {
    const map = new Map<string, string>();
    const writes: string[] = [];
    const w = new StallWatch({
      read: (key) => map.get(key),
      write: (key, value) => {
        writes.push(key);
        map.set(key, value);
      },
    });

    w.record({ kind: "running_tool", tool: "web_fetch" }, 0);
    w.record({ kind: "waiting_model" }, 1_000);
    w.record({ kind: "waiting_model" }, 2_000);

    // Three events, one key, one row: the old layout wrote three keys each.
    expect(writes).toEqual(["activity", "activity", "activity"]);
    expect(map.size).toBe(1);
  });

  it("reads the legacy three-key layout", () => {
    const map = new Map<string, string>([
      ["activity_at", "0"],
      ["activity_state", JSON.stringify({ kind: "running_tool", tool: "bash" })],
      ["stall_notified_at", ""],
    ]);
    const store: StallStore = {
      read: (key) => map.get(key),
      write: (key, value) => {
        map.set(key, value);
      },
    };

    const w = new StallWatch(store);
    expect(w.check(600_000)).toEqual({
      due: "notify",
      activity: { kind: "running_tool", tool: "bash" },
      idleMs: 600_000,
    });

    // A run that was live during the deploy re-arms through these two, not
    // through check(): losing the legacy clock here resets the stall clock.
    expect(w.activityAt()).toBe(0);
    expect(w.activity()).toEqual({ kind: "running_tool", tool: "bash" });

    // The next write lands in the single-key layout.
    w.record({ kind: "waiting_model" }, 700_000);
    expect(map.has("activity")).toBe(true);
  });

  it("keeps the legacy clock when it marks a report", () => {
    const map = new Map<string, string>([
      ["activity_at", "0"],
      ["activity_state", JSON.stringify({ kind: "waiting_model" })],
      ["stall_notified_at", ""],
    ]);
    const w = new StallWatch({
      read: (key) => map.get(key),
      write: (key, value) => {
        map.set(key, value);
      },
    });

    w.markNotified(600_000);

    // The backfilled row keeps the legacy clock and carries the report.
    expect(w.activityAt()).toBe(0);
    expect(w.check(1_800_000)).toEqual({ due: "later", at: 2_400_000 });
  });

  it("keeps a legacy notified flag from reporting twice", () => {
    const map = new Map<string, string>([
      ["activity_at", "0"],
      ["activity_state", JSON.stringify({ kind: "waiting_model" })],
      ["stall_notified_at", "600000"],
    ]);
    const w = new StallWatch({
      read: (key) => map.get(key),
      write: (key, value) => {
        map.set(key, value);
      },
    });

    expect(w.check(1_800_000).due).toBe("later");
  });

  it("exposes the last step and its clock", () => {
    const map = new Map<string, string>();
    const w = new StallWatch({
      read: (key) => map.get(key),
      write: (key, value) => {
        map.set(key, value);
      },
    });

    expect(w.activityAt()).toBeUndefined();
    expect(w.activity()).toBeUndefined();

    w.record({ kind: "waiting_model" }, 42);
    expect(w.activityAt()).toBe(42);
    expect(w.activity()).toEqual({ kind: "waiting_model" });
  });
});
