import { describe, expect, it } from "vitest";
import { parseTextAction } from "../../src/channels/text-action";

describe("parseTextAction", () => {
  it("parses an approval with its approval id", () => {
    expect(parseTextAction("批准 t3 ap1")).toEqual({
      action: "approve",
      taskId: "t3",
      approvalId: "ap1",
    });
  });

  it("parses a rejection with its approval id", () => {
    expect(parseTextAction("拒绝 t3 ap2")).toEqual({
      action: "reject",
      taskId: "t3",
      approvalId: "ap2",
    });
  });

  it("parses a cancel without an approval id", () => {
    expect(parseTextAction("取消 t3")).toEqual({
      action: "cancel",
      taskId: "t3",
    });
  });

  it("refuses an approval or rejection without an approval id", () => {
    // The model must never guess which approval the owner means.
    expect(parseTextAction("批准 t3")).toBeNull();
    expect(parseTextAction("拒绝 t3")).toBeNull();
  });

  it("refuses a cancel that carries an approval id", () => {
    expect(parseTextAction("取消 t3 ap1")).toBeNull();
  });

  it("ignores anything that is not the exact command shape", () => {
    expect(parseTextAction("批准t3 ap1")).toBeNull();
    expect(parseTextAction("批准 t3 ap1 extra")).toBeNull();
    expect(parseTextAction("请批准 t3 ap1")).toBeNull();
    expect(parseTextAction("批准")).toBeNull();
    expect(parseTextAction("")).toBeNull();
    expect(parseTextAction("hello")).toBeNull();
    expect(parseTextAction("approve t3 ap1")).toBeNull();
  });

  it("refuses ids that are not a task or approval number", () => {
    // "取消 明天" is chat, not an instruction to cancel a task called 明天.
    expect(parseTextAction("取消 明天")).toBeNull();
    expect(parseTextAction("批准 t3 审批")).toBeNull();
    expect(parseTextAction("批准 task3 ap1")).toBeNull();
  });

  it("accepts the quotes the WeChat hint shows", () => {
    // The hint reads 回复"批准 t3 ap1": copying it must work verbatim.
    expect(parseTextAction('"批准 t3 ap1"')).toEqual({
      action: "approve",
      taskId: "t3",
      approvalId: "ap1",
    });
    expect(parseTextAction("“拒绝 t3 ap1”")).toEqual({
      action: "reject",
      taskId: "t3",
      approvalId: "ap1",
    });
    expect(parseTextAction("'取消 t3'")).toEqual({
      action: "cancel",
      taskId: "t3",
    });
    expect(parseTextAction('  “批准 t3 ap1”  ')).toEqual({
      action: "approve",
      taskId: "t3",
      approvalId: "ap1",
    });
  });

  it("still refuses chatter and unbalanced quotes", () => {
    expect(parseTextAction('"批准 明天"')).toBeNull();
    expect(parseTextAction("“拒绝 t3”")).toBeNull();
    expect(parseTextAction('"取消 t3 ap1"')).toBeNull();
    expect(parseTextAction('"请批准 t3 ap1"')).toBeNull();
    expect(parseTextAction('“批准 t3 ap1')).toBeNull();
    expect(parseTextAction('批准 t3 ap1"')).toBeNull();
  });

  it("accepts surrounding whitespace only", () => {
    expect(parseTextAction("  批准 t3 ap1 ")).toEqual({
      action: "approve",
      taskId: "t3",
      approvalId: "ap1",
    });
  });

  it("keeps the two approvals of one task distinct", () => {
    expect(parseTextAction("批准 t3 ap1")?.approvalId).toBe("ap1");
    expect(parseTextAction("拒绝 t3 ap2")?.approvalId).toBe("ap2");
  });
});
