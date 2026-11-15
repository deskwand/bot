import { describe, expect, it } from "vitest";
import {
  OWNER_ID,
  butlerName,
  can,
  newTaskId,
  taskIdPattern,
  type MemberCapability,
  type Principal,
} from "../../src/members/principal";

const MEMBER_A = `m${"a".repeat(32)}`;
const MEMBER_B = `m${"b".repeat(32)}`;
const owner: Principal = { memberId: OWNER_ID, role: "owner", epoch: 1 };
const member = (id = MEMBER_A): Principal => ({
  memberId: id,
  role: "member",
  epoch: 1,
});

describe("principal capabilities", () => {
  it("角色不是主体替代品，成员不能管理成员", () => {
    const a = member("m1");
    expect(can(a, "ordinary-task")).toBe(true);
    expect(can(a, "manage-members")).toBe(false);
    expect(can({ ...a, role: "owner" }, "manage-members")).toBe(false);
    expect(can(a, "unknown" as MemberCapability)).toBe(false);
    expect(butlerName("owner")).toBe("owner");
    expect(butlerName("m1")).toBe("member:m1");
  });

  it("只有主人行可以管理成员和发起邀请", () => {
    expect(can(owner, "manage-members")).toBe(true);
    expect(can(owner, "ordinary-task")).toBe(true);
    expect(can(owner, "prepare-share")).toBe(true);
    expect(can(member(), "prepare-share")).toBe(true);
    expect(can({ ...owner, memberId: "m-other" }, "manage-members")).toBe(false);
    expect(can({ ...member(), memberId: OWNER_ID }, "manage-members")).toBe(
      false,
    );
  });
});

describe("task ids", () => {
  it("保持旧 tN 并避免成员任务与其他 Butler 冲突", () => {
    expect(newTaskId(owner, 1)).toBe("t1");
    const a = newTaskId(member(MEMBER_A), 1);
    const b = newTaskId(member(MEMBER_B), 1);
    expect(a).toBe(`${MEMBER_A}-t1`);
    expect(a).not.toBe(b);
    expect(a).not.toBe("t1");
  });

  it("识别两种任务 ID 前缀", () => {
    const pattern = taskIdPattern();
    expect(pattern.test("t12")).toBe(true);
    expect(pattern.test(`${MEMBER_A}-t12`)).toBe(true);
    for (const bad of [
      "t",
      "t1x",
      "-t1",
      `${MEMBER_A}-t`,
      `m${"a".repeat(31)}-t1`,
      `m${"A".repeat(32)}-t1`,
      `t1/../${MEMBER_A}`,
      "",
    ]) {
      expect(pattern.test(bad)).toBe(false);
    }
  });
});
