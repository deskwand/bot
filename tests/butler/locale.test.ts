import { describe, expect, it } from "vitest";
import {
  actionHint,
  actionLabel,
  approvalButtonLabel,
  approvalCardText,
  decisionSuffix,
  errorNotice,
  imageModelNotice,
  imageUnavailableNotice,
  maintenanceRetryText,
  maintenanceText,
  noChannelText,
  resolutionActiveList,
  resolutionNoActiveTask,
  resolutionNoPendingApproval,
  resolutionNoPendingApprovalId,
  resolutionPendingList,
  taskMissingText,
  unsupportedMessageNotice,
  voiceUnavailableNotice,
} from "../../src/butler/owner-copy";
import type { TaskRow } from "../../src/butler/tasks-repo";
import { resolveTextAction } from "../../src/butler/text-resolution";

const HAN = /\p{Script=Han}/u;

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function expectEnglish(text: string): void {
  expect(text).not.toMatch(HAN);
}

function task(id: string, handle: number | null, title: string): TaskRow {
  return {
    id,
    title,
    status: "running",
    chatId: "42",
    summary: null,
    artifacts: [],
    lastSeq: 0,
    createdAt: 0,
    updatedAt: 0,
    botId: null,
    handle,
    lastProgress: null,
    lastProgressAt: null,
    slowNotifiedAt: null,
  };
}

describe("action buttons and hints", () => {
  it("keeps the Chinese labels and hints", () => {
    expect(actionLabel("zh", "approve")).toBe("批准");
    expect(actionLabel("zh", "reject")).toBe("拒绝");
    expect(actionLabel("zh", "cancel")).toBe("取消");
    expect(actionHint("zh", "approve")).toBe("批准");
    expect(
      actionHint("zh", "approve", { taskId: "t1", approvalId: "ap2" }),
    ).toBe("批准 t1 ap2");
    expect(actionHint("zh", "cancel", { taskId: "#1" })).toBe("取消 #1");
    expect(approvalButtonLabel("zh", "approve")).toBe("批准");
    expect(approvalButtonLabel("zh", "reject")).toBe("拒绝");
  });

  it("uses English commands and labels", () => {
    expect(actionLabel("en", "approve")).toBe("approve");
    expect(actionLabel("en", "reject")).toBe("reject");
    expect(actionLabel("en", "cancel")).toBe("cancel");
    expect(
      actionHint("en", "approve", { taskId: "t1", approvalId: "ap2" }),
    ).toBe("approve t1 ap2");
    expect(actionHint("en", "cancel", { taskId: "#1" })).toBe("cancel #1");
    for (const action of ["approve", "reject"] as const) {
      expectEnglish(approvalButtonLabel("en", action));
    }
  });
});

describe("approval card", () => {
  it("keeps the Chinese card", () => {
    expect(
      approvalCardText("zh", {
        label: "#1",
        tool: "web_fetch",
        reason: "涉及付款",
        argsSummary: "https://example.com",
      }),
    ).toBe("#1 请求执行 web_fetch\n涉及付款\nhttps://example.com");
    expect(
      approvalCardText("zh", {
        label: "t1",
        prefix: "「价格哨兵」",
        tool: "web_fetch",
        argsSummary: "https://example.com",
      }),
    ).toBe("「价格哨兵」t1 请求执行 web_fetch\nhttps://example.com");
    expect(decisionSuffix("zh", "approved")).toBe("\n→ 已批准");
    expect(decisionSuffix("zh", "rejected")).toBe("\n→ 已拒绝");
    expect(decisionSuffix("zh", "expired")).toBe("\n→ 已过期");
  });

  it("writes the English card with the same parameters", () => {
    const text = approvalCardText("en", {
      label: "#1",
      prefix: '"Price sentinel" ',
      tool: "web_fetch",
      reason: "This spends money",
      argsSummary: "https://example.com",
    });
    expectEnglish(text);
    for (const part of [
      "Price sentinel",
      "#1",
      "web_fetch",
      "This spends money",
      "https://example.com",
    ]) {
      expect(text).toContain(part);
    }
    for (const decision of ["approved", "rejected", "expired"] as const) {
      expectEnglish(decisionSuffix("en", decision));
    }
    expect(decisionSuffix("en", "approved")).toContain("Approved");
  });
});

describe("butler notices", () => {
  it("keeps the Chinese notices", () => {
    expect(taskMissingText("zh")).toBe("任务不存在");
    expect(maintenanceText("zh")).toBe("维护中");
    expect(maintenanceRetryText("zh")).toBe("维护中，稍后再试");
    expect(noChannelText("zh")).toBe("没有可用渠道");
    expect(errorNotice("zh")).toBe("出错了，稍后再试");
    expect(imageUnavailableNotice("zh")).toBe(
      "收到了图片，但没能取到图片内容，请稍后再发一次",
    );
    expect(voiceUnavailableNotice("zh")).toBe(
      "收到了语音，但没能转成文字，请再发一次或换成文字",
    );
    expect(unsupportedMessageNotice("zh")).toBe(
      "目前只支持文字、图片和语音消息",
    );
    expect(imageModelNotice("zh")).toBe(
      "当前模型不支持图片，请在桌面端模型页换成支持视觉的模型",
    );
  });

  it("writes the English notices", () => {
    const messages = [
      taskMissingText("en"),
      maintenanceText("en"),
      maintenanceRetryText("en"),
      noChannelText("en"),
      errorNotice("en"),
      imageUnavailableNotice("en"),
      voiceUnavailableNotice("en"),
      unsupportedMessageNotice("en"),
      imageModelNotice("en"),
    ];
    for (const message of messages) expectEnglish(message);
  });
});

describe("resolution messages", () => {
  it("keeps the Chinese replies", () => {
    expect(resolutionNoActiveTask("zh", 9)).toBe(
      "#9 当前没有进行中的任务",
    );
    expect(resolutionNoPendingApproval("zh", "#1")).toBe("#1 没有待审批");
    expect(resolutionNoPendingApprovalId("zh", 1, "ap6")).toBe(
      "#1 没有待审批 ap6",
    );
    expect(
      resolutionActiveList("zh", [
        task("t1", 1, "沙箱测试"),
        task("t2", 2, "周报"),
      ]),
    ).toBe("当前有 2 个任务在进行，请写明编号：\n#1 沙箱测试\n#2 周报");
    expect(
      resolutionPendingList("zh", [
        { taskId: "t1", handle: 1, approvalId: "ap6", title: "沙箱测试" },
        { taskId: "t2", handle: 2, approvalId: "ap7", title: "周报" },
      ]),
    ).toBe("当前有 2 个待审批，请写明编号：\n#1 ap6 沙箱测试\n#2 ap7 周报");
  });

  it("writes the English replies with the same parameters", () => {
    const messages = [
      resolutionNoActiveTask("en", 9),
      resolutionNoPendingApproval("en", "#1"),
      resolutionNoPendingApprovalId("en", 1, "ap6"),
      resolutionActiveList("en", [
        task("t1", 1, "Sandbox test"),
        task("t2", 2, "Weekly report"),
      ]),
      resolutionPendingList("en", [
        { taskId: "t1", handle: 1, approvalId: "ap6", title: "Sandbox test" },
        { taskId: "t2", handle: 2, approvalId: "ap7", title: "Weekly report" },
      ]),
    ];
    for (const message of messages) expectEnglish(message);
    expect(messages[0]).toContain("#9");
    expect(messages[1]).toContain("#1");
    expect(messages[2]).toContain("ap6");
    expect(messages[3]).toContain("Sandbox test");
    expect(messages[3]).toContain("Weekly report");
    expect(messages[4]).toContain("ap7");
  });

  it("threads the locale through resolveTextAction", () => {
    const t1 = task("t1", 1, "Sandbox test");
    const t2 = task("t2", 2, "Weekly report");
    const zh = resolveTextAction(
      "zh",
      { action: "cancel", target: { kind: "implicit" } },
      [t1, t2],
      [],
    );
    expect(zh).toEqual({
      kind: "reply",
      text: "当前有 2 个任务在进行，请写明编号：\n#1 Sandbox test\n#2 Weekly report",
    });
    const en = resolveTextAction(
      "en",
      { action: "cancel", target: { kind: "implicit" } },
      [t1, t2],
      [],
    );
    expect(en.kind).toBe("reply");
    if (en.kind === "reply") {
      expectEnglish(en.text);
      expect(en.text).toContain("Sandbox test");
      expect(en.text).toContain("#2");
    }
  });
});
