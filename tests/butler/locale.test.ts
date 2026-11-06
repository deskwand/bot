import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import validConfig from "../../contracts/fixtures/config-valid.json";
import { setChannelOverride } from "../../src/channels/override";
import type { TaskSpec } from "../../src/protocol";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { fakeChannel } from "../helpers/fake-channel";
import {
  actionHint,
  actionLabel,
  approvalButtonLabel,
  approvalCardText,
  botNoticeText,
  cancelButton,
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
  retryHint,
  taskCancelledText,
  taskCompletedText,
  taskFailedText,
  taskMissingText,
  taskProgressText,
  taskStartedText,
  taskStartFailedText,
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
    expect(approvalButtonLabel("zh", "approve")).toBe("✅ 批准");
    expect(approvalButtonLabel("zh", "reject")).toBe("❌ 拒绝");
    expect(cancelButton("zh", "#1")).toEqual({
      label: "取消",
      hint: "取消 #1",
    });
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
    expectEnglish(cancelButton("en", "#1").label);
    expectEnglish(cancelButton("en", "#1").hint);
    expect(cancelButton("en", "#1").hint).toContain("#1");
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
    ).toBe("🔐 #1 请求执行 web_fetch\n⚠️ 涉及付款\nhttps://example.com");
    expect(
      approvalCardText("zh", {
        label: "t1",
        prefix: "🤖 价格哨兵 ",
        tool: "web_fetch",
        argsSummary: "https://example.com",
      }),
    ).toBe("🤖 价格哨兵 🔐 t1 请求执行 web_fetch\nhttps://example.com");
    expect(decisionSuffix("zh", "approved")).toBe("\n→ 已批准");
    expect(decisionSuffix("zh", "rejected")).toBe("\n→ 已拒绝");
    expect(decisionSuffix("zh", "expired")).toBe("\n→ 已过期");
  });

  it("writes the English card with the same parameters", () => {
    const text = approvalCardText("en", {
      label: "#1",
      prefix: "🤖 Price sentinel ",
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

describe("task lifecycle copy", () => {
  it("keeps the Chinese lifecycle messages", () => {
    expect(taskStartedText("zh", "#1", "查天气")).toBe(
      "⏳ #1 查天气：已开始",
    );
    expect(taskStartFailedText("zh", "#1", "查天气", "boom")).toBe(
      "❌ #1 查天气：boom",
    );
    expect(taskProgressText("zh", "#1", "查天气", "读取页面")).toBe(
      "⏳ #1 查天气：读取页面",
    );
    expect(taskCompletedText("zh", "#1", "查天气")).toBe(
      "✅ #1 查天气：已完成",
    );
    expect(taskCompletedText("zh", "#1", "查天气", "摘要")).toBe(
      "✅ #1 查天气：摘要",
    );
    expect(taskFailedText("zh", "#1", "查天气", "超时")).toBe(
      "❌ #1 查天气：超时",
    );
    expect(retryHint("zh", true)).toBe('\n回复"重试"可继续');
    expect(retryHint("zh", false)).toBe("");    expect(taskCancelledText("zh", "#1", "查天气")).toBe(
      "🚫 #1 查天气：已取消",
    );
  });

  it("writes the English lifecycle messages with the same parameters", () => {
    const messages = [
      taskStartedText("en", "#1", "Weather"),
      taskStartFailedText("en", "#1", "Weather", "boom"),
      taskProgressText("en", "#1", "Weather", "Reading the page"),
      taskCompletedText("en", "#1", "Weather"),
      taskCompletedText("en", "#1", "Weather", "Summary"),
      taskFailedText("en", "#1", "Weather", "Timed out"),
      taskCancelledText("en", "#1", "Weather"),
      retryHint("en", true),
    ];
    for (const message of messages) expectEnglish(message);
    expect(retryHint("en", true)).toBe('\nReply "retry" to continue');
    expect(messages[0]).toContain("Weather");
    expect(messages[2]).toContain("Reading the page");
    expect(messages[4]).toContain("Summary");
    expect(messages[7]).toContain("retry");
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
    expect(botNoticeText("zh", "价格哨兵", "降价了")).toBe(
      "🤖 价格哨兵：降价了",
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
      botNoticeText("en", "Price sentinel", "Price dropped"),
    ];
    for (const message of messages) expectEnglish(message);
    expect(messages[9]).toContain("Price sentinel");
    expect(messages[9]).toContain("Price dropped");
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

describe("butler sends the owner's language", () => {
  it("starts a task in English when the config says en", async () => {
    await seedOwnerAddress("42");
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);

    const ENV = env as unknown as Record<string, unknown>;
    const saved = ENV.DESKWAND_CONFIG;
    ENV.DESKWAND_CONFIG = { ...validConfig, locale: "en" };
    try {
      const stub = env.BUTLER.get(env.BUTLER.idFromName("locale-en"));
      await runInDurableObject(stub, (instance) => {
        (
          instance as unknown as { taskFor(id: string): unknown }
        ).taskFor = () => ({
          start: async (_spec: TaskSpec) => {},
        });
      });

      await stub.spawn("Weather", "Check the weather");

      expect(channel.sent).toHaveLength(1);
      expectEnglish(channel.sent[0]!.text);
      expect(channel.sent[0]!.text).toContain("Weather");
      expectEnglish(JSON.stringify(channel.sent[0]!.buttons));
    } finally {
      ENV.DESKWAND_CONFIG = saved;
      setChannelOverride("telegram", null);
    }
  });
});
