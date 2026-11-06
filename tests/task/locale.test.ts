import { describe, expect, it } from "vitest";
import { actionHint, approvalCardText } from "../../src/butler/owner-copy";
import { approvalSummary } from "../../src/task/approvals";
import {
  approvalDecisionText,
  approvalExpiredText,
  approvalHandledText,
  autoApprovedText,
  cancelBlockedText,
  cancelNotStartedText,
  cancelOkText,
  clearedRulesText,
  finishBotText,
  missingApprovalIdText,
  parkedTaskText,
  progressArtifactText,
  progressReadText,
  progressSaveText,
  progressSearchText,
  progressTimeText,
  proposedRulesText,
  retryBlockedText,
  retryNotRetryableText,
  retryNotStartedText,
  retryOkText,
  steerBlockedText,
  steerNotStartedText,
  steerOkText,
  taskIncompleteText,
  taskStateLabel,
} from "../../src/task/owner-copy";

const HAN = /\p{Script=Han}/u;

function expectEnglish(text: string): void {
  expect(text).not.toMatch(HAN);
}

describe("progress labels", () => {
  it("keeps the Chinese copy", () => {
    expect(progressSearchText("zh", "天气")).toBe("搜索：天气");
    expect(progressArtifactText("zh", "art1")).toBe("读取产物：art1");
    expect(progressTimeText("zh")).toBe("查看时间");
    expect(progressReadText("zh", "https://example.com")).toBe(
      "读取：https://example.com",
    );
    expect(progressSaveText("zh", "a.txt")).toBe("保存：a.txt");
  });

  it("progress labels follow locale", () => {
    const labels = [
      progressSearchText("en", "weather"),
      progressArtifactText("en", "art1"),
      progressTimeText("en"),
      progressReadText("en", "https://example.com"),
      progressSaveText("en", "a.txt"),
    ];
    for (const label of labels) expectEnglish(label);
    expect(labels[0]).toContain("weather");
    expect(labels[1]).toContain("art1");
    expect(labels[3]).toContain("https://example.com");
    expect(labels[4]).toContain("a.txt");
  });
});

describe("task state labels", () => {
  it("keeps the Chinese names", () => {
    expect(taskStateLabel("zh", "queued")).toBe("排队中");
    expect(taskStateLabel("zh", "running")).toBe("运行中");
    expect(taskStateLabel("zh", "completed")).toBe("完成");
    expect(taskStateLabel("zh", "failed")).toBe("失败");
    expect(taskStateLabel("zh", "cancelled")).toBe("取消");
  });

  it("is English in en", () => {
    for (const state of [
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ] as const) {
      expectEnglish(taskStateLabel("en", state));
    }
  });
});

describe("task control messages", () => {
  it("keeps the Chinese copy", () => {
    expect(steerNotStartedText("zh")).toBe("任务尚未开始，无法追加指令");
    expect(steerBlockedText("zh", "t1", "completed")).toBe(
      "任务 t1 已完成，无法追加指令",
    );
    expect(steerOkText("zh", "t1")).toBe("已向任务 t1 追加指令");
    expect(cancelNotStartedText("zh")).toBe("任务尚未开始，无法取消");
    expect(cancelBlockedText("zh", "t1", "completed")).toBe(
      "任务 t1 已完成，无法取消",
    );
    expect(cancelOkText("zh", "t1")).toBe("任务 t1 已取消");
    expect(retryNotStartedText("zh")).toBe("任务尚未开始，无法重试");
    expect(retryBlockedText("zh", "t1", "completed")).toBe(
      "任务 t1 已完成，无法重试",
    );
    expect(retryNotRetryableText("zh", "t1")).toBe("任务 t1 的失败不可重试");
    expect(retryOkText("zh", "t1")).toBe("任务 t1 已重新开始");
    expect(missingApprovalIdText("zh")).toBe("缺少审批编号");
    expect(parkedTaskText("zh")).toBe("任务反复中断，已暂停");
    expect(taskIncompleteText("zh")).toBe("任务未完成");
  });

  it("is English in en", () => {
    const texts = [
      steerNotStartedText("en"),
      steerBlockedText("en", "t1", "completed"),
      steerOkText("en", "t1"),
      cancelNotStartedText("en"),
      cancelBlockedText("en", "t1", "completed"),
      cancelOkText("en", "t1"),
      retryNotStartedText("en"),
      retryBlockedText("en", "t1", "completed"),
      retryNotRetryableText("en", "t1"),
      retryOkText("en", "t1"),
      missingApprovalIdText("en"),
      parkedTaskText("en"),
      taskIncompleteText("en"),
    ];
    for (const text of texts) expectEnglish(text);
    for (const index of [1, 2, 4, 5, 7, 8, 9]) {
      expect(texts[index]).toContain("t1");
    }
  });
});

describe("approval copy", () => {
  it("keeps the Chinese copy", () => {
    expect(approvalHandledText("zh")).toBe("该审批已处理或已失效");
    expect(approvalExpiredText("zh")).toBe("该审批已失效");
    expect(approvalDecisionText("zh", "approved")).toBe("已批准");
    expect(approvalDecisionText("zh", "rejected")).toBe("已拒绝");
    expect(autoApprovedText("zh", "http_request", "按指令保存")).toBe(
      "✔️ 自动放行 http_request：按指令保存",
    );
    expect(proposedRulesText("zh", "踩坑", "新规则")).toBe(
      "理由：踩坑\n新守则：\n新规则",
    );
    expect(clearedRulesText("zh")).toBe("（清空守则）");
  });

  it("is English in en", () => {
    const texts = [
      approvalHandledText("en"),
      approvalExpiredText("en"),
      approvalDecisionText("en", "approved"),
      approvalDecisionText("en", "rejected"),
      autoApprovedText("en", "http_request", "Matches the saved rules"),
      proposedRulesText("en", "Pays a bill", "New rule"),
      clearedRulesText("en"),
    ];
    for (const text of texts) expectEnglish(text);
    expect(texts[4]).toContain("http_request");
    expect(texts[5]).toContain("Pays a bill");
    expect(texts[5]).toContain("New rule");
  });

  it("localizes the proposed rules summary", () => {
    const zhArgs = JSON.stringify({ content: "  ", reason: "不设限" });
    const enArgs = JSON.stringify({ content: "  ", reason: "No limits" });

    expect(approvalSummary("propose_rules", zhArgs, "zh")).toBe(
      "理由：不设限\n新守则：\n（清空守则）",
    );
    expectEnglish(approvalSummary("propose_rules", enArgs, "en"));
    expect(approvalSummary("propose_rules", enArgs, "en")).toContain(
      clearedRulesText("en"),
    );
  });

  it("localizes the finish bot summary", () => {
    expect(finishBotText("zh", "完成")).toBe("申请永久结束机器人\n理由：完成");
    expect(
      approvalSummary("finish_bot", JSON.stringify({ reason: "完成" }), "zh"),
    ).toBe("申请永久结束机器人\n理由：完成");

    const en = approvalSummary(
      "finish_bot",
      JSON.stringify({ reason: "done" }),
      "en",
    );
    expectEnglish(en);
    expect(en).toContain("Reason: done");
  });

  it("truncates a long finish reason", () => {
    const reason = "x".repeat(400);
    const summary = approvalSummary(
      "finish_bot",
      JSON.stringify({ reason }),
      "zh",
    );

    expect(summary).toContain(`${"x".repeat(300)}…`);
    expect(summary).not.toContain("x".repeat(301));
  });

  it("approval card is English", () => {
    const card = approvalCardText("en", {
      prefix: "🤖 Price scout ",
      label: "#1",
      tool: "http_request",
      reason: "Pays a bill",
      argsSummary: [
        autoApprovedText("en", "http_request", "Matches the saved rules"),
        actionHint("en", "approve", { taskId: "#1", approvalId: "ap2" }),
      ].join("\n"),
    });

    expectEnglish(card);
    expect(card).toContain("http_request");
    expect(card).toContain("Pays a bill");
    expect(card).toContain("approve #1 ap2");
  });
});
