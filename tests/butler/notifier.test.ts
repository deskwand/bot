import { describe, expect, it } from "vitest";
import { ProgressThrottle } from "../../src/butler/notifier";

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
