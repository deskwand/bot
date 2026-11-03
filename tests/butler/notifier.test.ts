import { describe, expect, it } from "vitest";
import {
  ProgressHeartbeat,
  ProgressThrottle,
  type ProgressPolicy,
} from "../../src/butler/notifier";

describe("ProgressThrottle", () => {
  it("lets one progress message through per interval and keeps the latest", () => {
    const t = new ProgressThrottle(3000);
    expect(t.offer("t1", "a", 0)).toBe("a");
    expect(t.offer("t1", "b", 1000)).toBeNull();
    expect(t.offer("t1", "c", 2000)).toBeNull();
    expect(t.takeDue(2999)).toEqual([]);
    expect(t.takeDue(3000)).toEqual([{ taskId: "t1", text: "c" }]);
    expect(t.offer("t2", "x", 1000)).toBe("x"); // per-task clocks
  });

  it("drops buffered progress", () => {
    const t = new ProgressThrottle(3000);
    expect(t.offer("t1", "a", 0)).toBe("a");
    expect(t.offer("t1", "b", 1000)).toBeNull();
    t.drop("t1");
    expect(t.takeDue(5000)).toEqual([]);
  });
});

describe("ProgressHeartbeat", () => {
  it("stays silent for the first window and then sends the latest frame", () => {
    const h = new ProgressHeartbeat(180_000, 60_000);

    expect(h.offer("t1", "a", 10_000)).toBeNull();
    expect(h.offer("t1", "b", 30_000)).toBeNull();
    expect(h.takeDue(69_999)).toEqual([]);
    expect(h.takeDue(70_000)).toEqual([{ taskId: "t1", text: "b" }]);
  });

  it("sends at most one heartbeat per interval afterwards", () => {
    const h = new ProgressHeartbeat(180_000, 60_000);
    expect(h.offer("t1", "a", 0)).toBeNull();
    expect(h.takeDue(60_000)).toEqual([{ taskId: "t1", text: "a" }]);

    expect(h.offer("t1", "b", 61_000)).toBeNull();
    expect(h.offer("t1", "c", 200_000)).toBeNull();
    expect(h.takeDue(239_999)).toEqual([]);
    expect(h.takeDue(240_000)).toEqual([{ taskId: "t1", text: "c" }]);
  });

  it("keeps task clocks independent and drops on demand", () => {
    const h = new ProgressHeartbeat(180_000, 60_000);
    expect(h.offer("t1", "a", 0)).toBeNull();
    expect(h.offer("t2", "x", 0)).toBeNull();
    h.drop("t1");
    expect(h.dueAt("t1")).toBeNull();
    expect(h.takeDue(60_000)).toEqual([{ taskId: "t2", text: "x" }]);
  });

  it("is usable as a ProgressPolicy alongside the throttle", () => {
    const policies: ProgressPolicy[] = [
      new ProgressHeartbeat(),
      new ProgressThrottle(3000),
    ];
    expect(policies.map((policy) => policy.offer("t1", "a", 0))).toEqual([
      null,
      "a",
    ]);
  });
});
