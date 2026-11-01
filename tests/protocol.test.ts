import { describe, expect, it } from "vitest";
import { decodeAction, encodeAction } from "../src/protocol";

describe("action callback_data", () => {
  it("round-trips actions", () => {
    expect(encodeAction({ action: "cancel", taskId: "t12" })).toBe("a:cancel:t12");
    expect(decodeAction("a:approve:t3:ap7")).toEqual({
      action: "approve",
      taskId: "t3",
      approvalId: "ap7",
    });
  });

  it("round-trips every action kind", () => {
    for (const action of ["approve", "reject", "cancel"] as const) {
      const data = encodeAction({ action, taskId: "t42" });
      expect(decodeAction(data)).toEqual({ action, taskId: "t42" });
    }
  });

  it("rejects malformed data", () => {
    for (const d of [
      "",
      "x:cancel:t1",
      "a:delete:t1",
      "a:cancel:",
      "a:cancel:t1:a:b",
    ]) {
      expect(decodeAction(d)).toBeNull();
    }
  });

  it("throws when encoded data exceeds 64 bytes", () => {
    expect(() =>
      encodeAction({ action: "approve", taskId: "t1", approvalId: "x".repeat(60) }),
    ).toThrow();
  });
});
