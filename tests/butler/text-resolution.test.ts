import { describe, expect, it } from "vitest";
import type { TaskRow } from "../../src/butler/tasks-repo";
import {
  resolveTextAction,
  type PendingApproval,
} from "../../src/butler/text-resolution";

function task(id: string, handle: number | null, title: string): TaskRow {
  return {
    id,
    title,
    status: "running",
    chatId: "42",
    progressMessageRef: null,
    summary: null,
    artifacts: [],
    lastSeq: 0,
    createdAt: 0,
    updatedAt: 0,
    botId: null,
    handle,
  };
}

function pending(row: TaskRow, approvalId: string): PendingApproval {
  return {
    taskId: row.id,
    handle: row.handle,
    approvalId,
    title: row.title,
  };
}

const t1 = task("t1", 1, "沙箱测试");
const t2 = task("t2", 2, "周报");
const t3 = task("t3", 3, "备份");

const implicitCancel = {
  action: "cancel",
  target: { kind: "implicit" },
} as const;
const implicitApprove = {
  action: "approve",
  target: { kind: "implicit" },
} as const;
const implicitReject = {
  action: "reject",
  target: { kind: "implicit" },
} as const;

function handleCommand(
  action: "approve" | "reject" | "cancel",
  handle: number,
  approvalId?: string,
) {
  return approvalId === undefined
    ? { action, target: { kind: "handle", handle } as const }
    : { action, target: { kind: "handle", handle } as const, approvalId };
}

describe("resolveTextAction", () => {
  describe("an implicit cancel", () => {
    it("is chat when no task is active", () => {
      expect(resolveTextAction("zh", implicitCancel, [], [])).toEqual({
        kind: "chat",
      });
    });

    it("cancels the only active task", () => {
      expect(resolveTextAction("zh", implicitCancel, [t1], [])).toEqual({
        kind: "action",
        taskId: "t1",
        label: "#1",
      });
    });

    it("lists the active tasks when the target is ambiguous", () => {
      expect(resolveTextAction("zh", implicitCancel, [t1, t2], [])).toEqual({
        kind: "reply",
        text: "当前有 2 个任务在进行，请写明编号：\n#1 沙箱测试\n#2 周报",
      });
    });
  });

  describe("a cancel by handle", () => {
    it("cancels the matching active task", () => {
      expect(
        resolveTextAction("zh",
          handleCommand("cancel", 2),
          [t1, t2],
          [],
        ),
      ).toEqual({ kind: "action", taskId: "t2", label: "#2" });
    });

    it("replies when no active task owns the handle", () => {
      expect(resolveTextAction("zh", handleCommand("cancel", 9), [t1], [])).toEqual({
        kind: "reply",
        text: "#9 当前没有进行中的任务",
      });
    });
  });

  describe("an implicit approval", () => {
    it("is chat when nothing is pending", () => {
      expect(resolveTextAction("zh", implicitApprove, [t1], [])).toEqual({
        kind: "chat",
      });
    });

    it("acts on the only pending approval", () => {
      expect(
        resolveTextAction("zh", implicitApprove, [t1], [pending(t1, "ap6")]),
      ).toEqual({
        kind: "action",
        taskId: "t1",
        label: "#1",
        approvalId: "ap6",
      });
    });

    it("lists the pending approvals when more than one is open", () => {
      expect(
        resolveTextAction("zh",
          implicitApprove,
          [t1, t2],
          [pending(t1, "ap6"), pending(t2, "ap7")],
        ),
      ).toEqual({
        kind: "reply",
        text: "当前有 2 个待审批，请写明编号：\n#1 ap6 沙箱测试\n#2 ap7 周报",
      });
    });

    it("applies the same rules to a rejection", () => {
      expect(resolveTextAction("zh", implicitReject, [t1], [])).toEqual({
        kind: "chat",
      });
      expect(
        resolveTextAction("zh", implicitReject, [t1], [pending(t1, "ap6")]),
      ).toEqual({
        kind: "action",
        taskId: "t1",
        label: "#1",
        approvalId: "ap6",
      });
    });
  });

  describe("an approval by handle", () => {
    it("replies when the task has nothing pending", () => {
      expect(resolveTextAction("zh", handleCommand("approve", 1), [t1], [])).toEqual(
        {
          kind: "reply",
          text: "#1 没有待审批",
        },
      );
    });

    it("acts on the task's only pending approval", () => {
      expect(
        resolveTextAction("zh",
          handleCommand("approve", 1),
          [t1],
          [pending(t1, "ap6")],
        ),
      ).toEqual({
        kind: "action",
        taskId: "t1",
        label: "#1",
        approvalId: "ap6",
      });
    });

    it("lists both approvals when the task has two pending", () => {
      expect(
        resolveTextAction("zh",
          handleCommand("approve", 1),
          [t1],
          [pending(t1, "ap6"), pending(t1, "ap7")],
        ),
      ).toEqual({
        kind: "reply",
        text: "当前有 2 个待审批，请写明编号：\n#1 ap6 沙箱测试\n#1 ap7 沙箱测试",
      });
    });

    it("replies when no active task owns the handle", () => {
      expect(
        resolveTextAction("zh", handleCommand("approve", 9), [t1], []),
      ).toEqual({
        kind: "reply",
        text: "#9 当前没有进行中的任务",
      });
    });

    it("applies the same rules to a rejection", () => {
      expect(
        resolveTextAction("zh",
          handleCommand("reject", 1),
          [t1],
          [pending(t1, "ap6")],
        ),
      ).toEqual({
        kind: "action",
        taskId: "t1",
        label: "#1",
        approvalId: "ap6",
      });
    });
  });

  describe("an approval by handle and approval id", () => {
    it("acts when that approval is pending on the task", () => {
      expect(
        resolveTextAction("zh",
          handleCommand("approve", 1, "ap6"),
          [t1],
          [pending(t1, "ap6")],
        ),
      ).toEqual({
        kind: "action",
        taskId: "t1",
        label: "#1",
        approvalId: "ap6",
      });
    });

    it("replies when that approval is not pending on the task", () => {
      // Approval ids are per task and handles are reused, so an old
      // `批准 #1 ap1` must not reach a newer task's ap1.
      expect(
        resolveTextAction("zh",
          handleCommand("approve", 1, "ap6"),
          [t1],
          [pending(t1, "ap7")],
        ),
      ).toEqual({
        kind: "reply",
        text: "#1 没有待审批 ap6",
      });
    });

    it("still needs an active task with the handle", () => {
      expect(
        resolveTextAction("zh", handleCommand("approve", 9, "ap6"), [t1], []),
      ).toEqual({
        kind: "reply",
        text: "#9 当前没有进行中的任务",
      });
    });
  });

  it("labels a legacy active task by its internal id", () => {
    const legacy = task("t7", null, "旧任务");
    expect(resolveTextAction("zh", implicitCancel, [legacy], [])).toEqual({
      kind: "action",
      taskId: "t7",
      label: "t7",
    });
    expect(
      resolveTextAction("zh", implicitApprove, [legacy], [pending(legacy, "ap1")]),
    ).toEqual({
      kind: "action",
      taskId: "t7",
      label: "t7",
      approvalId: "ap1",
    });
  });

  it("ignores other tasks when checking a handle", () => {
    expect(
      resolveTextAction("zh", handleCommand("approve", 3), [t1, t3], [pending(t1, "ap6")]),
    ).toEqual({ kind: "reply", text: "#3 没有待审批" });
  });
});
