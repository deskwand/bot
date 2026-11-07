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
});
