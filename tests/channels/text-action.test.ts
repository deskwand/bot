import { describe, expect, it } from "vitest";
import { actionHint } from "../../src/butler/owner-copy";
import { parseTextAction, textHint } from "../../src/channels/text-action";

describe("parseTextAction", () => {
  it("parses an approval with its approval id", () => {
    expect(parseTextAction("批准 t3 ap1")).toEqual({
      action: "approve",
      target: { kind: "taskId", taskId: "t3" },
      approvalId: "ap1",
    });
  });

  it("parses a rejection with its approval id", () => {
    expect(parseTextAction("拒绝 t3 ap2")).toEqual({
      action: "reject",
      target: { kind: "taskId", taskId: "t3" },
      approvalId: "ap2",
    });
  });

  it("parses a cancel without an approval id", () => {
    expect(parseTextAction("取消 t3")).toEqual({
      action: "cancel",
      target: { kind: "taskId", taskId: "t3" },
    });
  });

  it("parses the implicit commands", () => {
    expect(parseTextAction("取消")).toEqual({
      action: "cancel",
      target: { kind: "implicit" },
    });
    expect(parseTextAction("批准")).toEqual({
      action: "approve",
      target: { kind: "implicit" },
    });
    expect(parseTextAction("拒绝")).toEqual({
      action: "reject",
      target: { kind: "implicit" },
    });
  });

  it("parses a handle with a half-width or full-width hash", () => {
    expect(parseTextAction("取消 #1")).toEqual({
      action: "cancel",
      target: { kind: "handle", handle: 1 },
    });
    expect(parseTextAction("取消 ＃1")).toEqual({
      action: "cancel",
      target: { kind: "handle", handle: 1 },
    });
    expect(parseTextAction('"取消 #1"')).toEqual({
      action: "cancel",
      target: { kind: "handle", handle: 1 },
    });
  });

  it("parses a handle without the hash", () => {
    // The WeChat hint drops the # so the command stays easy to type.
    expect(parseTextAction("取消 1")).toEqual({
      action: "cancel",
      target: { kind: "handle", handle: 1 },
    });
  });

  it("parses an approval by handle, with or without its approval id", () => {
    expect(parseTextAction("批准 #2")).toEqual({
      action: "approve",
      target: { kind: "handle", handle: 2 },
    });
    expect(parseTextAction("批准 #2 ap6")).toEqual({
      action: "approve",
      target: { kind: "handle", handle: 2 },
      approvalId: "ap6",
    });
  });

  it("refuses a legacy approval or rejection without an approval id", () => {
    // The model must never guess which approval the owner means.
    expect(parseTextAction("批准 t3")).toBeNull();
    expect(parseTextAction("拒绝 t3")).toBeNull();
  });

  it("refuses an approval id without a task", () => {
    // `ap` is unique only within a task.
    expect(parseTextAction("批准 ap6")).toBeNull();
    expect(parseTextAction("拒绝 ap6")).toBeNull();
  });

  it("refuses a cancel that carries an approval id", () => {
    expect(parseTextAction("取消 t3 ap1")).toBeNull();
    expect(parseTextAction("取消 #1 ap1")).toBeNull();
    expect(parseTextAction("取消 ap1")).toBeNull();
  });

  it("ignores anything that is not the exact command shape", () => {
    expect(parseTextAction("批准t3 ap1")).toBeNull();
    expect(parseTextAction("批准 t3 ap1 extra")).toBeNull();
    expect(parseTextAction("请批准 t3 ap1")).toBeNull();
    expect(parseTextAction("批准 #1 吧")).toBeNull();
    expect(parseTextAction("取消订单")).toBeNull();
    expect(parseTextAction("批准一下")).toBeNull();
    expect(parseTextAction("")).toBeNull();
    expect(parseTextAction("hello")).toBeNull();
    expect(parseTextAction("please approve t3 ap1")).toBeNull();
  });

  it("refuses ids that are not a task or approval number", () => {
    // "取消 明天" is chat, not an instruction to cancel a task called 明天.
    expect(parseTextAction("取消 明天")).toBeNull();
    expect(parseTextAction("批准 t3 审批")).toBeNull();
    expect(parseTextAction("批准 task3 ap1")).toBeNull();
  });

  it("only makes the verb case-insensitive", () => {
    // The ids stay lowercase so an uppercase id is chatter, not a target.
    expect(parseTextAction("批准 T61 ap1")).toBeNull();
    expect(parseTextAction("approve t1 AP2")).toBeNull();
    expect(parseTextAction("APPROVE t1 ap2")).toEqual({
      action: "approve",
      target: { kind: "taskId", taskId: "t1" },
      approvalId: "ap2",
    });
    expect(parseTextAction("Approve #1")).toEqual({
      action: "approve",
      target: { kind: "handle", handle: 1 },
    });
  });

  it("accepts the quotes the WeChat hint shows", () => {
    // The hint reads 回复"批准 #1 ap1": copying it must work verbatim.
    expect(parseTextAction('"批准 #1 ap1"')).toEqual({
      action: "approve",
      target: { kind: "handle", handle: 1 },
      approvalId: "ap1",
    });
    expect(parseTextAction("“拒绝 t3 ap1”")).toEqual({
      action: "reject",
      target: { kind: "taskId", taskId: "t3" },
      approvalId: "ap1",
    });
    expect(parseTextAction("'取消 t3'")).toEqual({
      action: "cancel",
      target: { kind: "taskId", taskId: "t3" },
    });
    expect(parseTextAction('  “批准 t3 ap1”  ')).toEqual({
      action: "approve",
      target: { kind: "taskId", taskId: "t3" },
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
      target: { kind: "taskId", taskId: "t3" },
      approvalId: "ap1",
    });
  });

  it("keeps the two approvals of one task distinct", () => {
    expect(parseTextAction("批准 t3 ap1")?.approvalId).toBe("ap1");
    expect(parseTextAction("拒绝 t3 ap2")?.approvalId).toBe("ap2");
  });
});

describe("bilingual commands", () => {
  it("parses English commands exactly like their Chinese counterparts", () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["approve", "批准"],
      ["Approve #2", "批准 #2"],
      ["reject t61", "拒绝 t61"],
      ["cancel 3", "取消 3"],
      ["APPROVE #1 ap2", "批准 #1 ap2"],
      ['"approve #1 ap2"', '"批准 #1 ap2"'],
    ];
    for (const [english, chinese] of pairs) {
      expect(parseTextAction(english)).toEqual(parseTextAction(chinese));
    }

    expect(parseTextAction("approve")).toEqual({
      action: "approve",
      target: { kind: "implicit" },
    });
    expect(parseTextAction("Approve #2")).toEqual({
      action: "approve",
      target: { kind: "handle", handle: 2 },
    });
    expect(parseTextAction("reject t61 ap1")).toEqual({
      action: "reject",
      target: { kind: "taskId", taskId: "t61" },
      approvalId: "ap1",
    });
    expect(parseTextAction("cancel 3")).toEqual({
      action: "cancel",
      target: { kind: "handle", handle: 3 },
    });
    expect(parseTextAction("APPROVE #1 ap2")).toEqual({
      action: "approve",
      target: { kind: "handle", handle: 1 },
      approvalId: "ap2",
    });
    expect(parseTextAction('"approve #1 ap2"')).toEqual({
      action: "approve",
      target: { kind: "handle", handle: 1 },
      approvalId: "ap2",
    });
  });

  it("does not accept partial words", () => {
    expect(parseTextAction("approved")).toBeNull();
    expect(parseTextAction("cancellation")).toBeNull();
  });

  it("every hint round-trips through the parser", () => {
    const quote = /"([^"]+)"/;
    for (const locale of ["zh", "en"] as const) {
      for (const action of ["approve", "reject", "cancel"] as const) {
        const approvalId = action === "cancel" ? undefined : "ap7";
        const hint = textHint(
          locale,
          actionHint(locale, action, {
            taskId: "#3",
            ...(approvalId === undefined ? {} : { approvalId }),
          }),
        );
        const command = quote.exec(hint)?.[1];
        expect(command).toBeDefined();

        const parsed = parseTextAction(command!);
        expect(parsed?.action).toBe(action);
        expect(parsed?.target).toEqual({ kind: "handle", handle: 3 });
        expect(parsed?.approvalId).toBe(approvalId);
      }
    }
  });

  it("writes the reply hint in the owner's language", () => {
    expect(textHint("zh", "批准 #1 ap1")).toBe('回复"批准 #1 ap1"');
    expect(textHint("en", "approve #1 ap1")).toBe('Reply "approve #1 ap1"');
  });
});
