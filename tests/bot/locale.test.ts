import { describe, expect, it } from "vitest";
import {
  botDailyLimitText,
  botFailingText,
  botFinishedText,
  botRecoveredText,
  botRunTimeoutText,
} from "../../src/bot/owner-copy";

const HAN = /\p{Script=Han}/u;

function expectEnglish(text: string): void {
  expect(text).not.toMatch(HAN);
}

describe("bot notices", () => {
  it("keeps the Chinese copy", () => {
    expect(botFinishedText("zh", "价格已降到目标")).toBe(
      "已结束，不会再唤醒（原因：价格已降到目标）",
    );
    expect(botFinishedText("zh", null)).toBe(
      "已结束，不会再唤醒（原因：未说明）",
    );
    expect(botDailyLimitText("zh", 48)).toBe(
      "今日唤醒已达 48 次，推迟到明天 00:00 UTC",
    );
    expect(botFailingText("zh", 3, "boom", "6h")).toBe(
      "连续 3 次失败（最近原因：boom），会继续每 6h 重试一次",
    );
    expect(botRecoveredText("zh")).toBe(
      "已恢复正常",
    );
    expect(botRunTimeoutText("zh")).toBe("运行超过 24 小时，已取消");
  });

  it("is English in en", () => {
    const finished = botFinishedText("en", "Price dropped");
    const finishUnknown = botFinishedText("en", null);
    const daily = botDailyLimitText("en", 48);
    const failing = botFailingText("en", 3, "boom", "6h");
    const recovered = botRecoveredText("en");
    const timeout = botRunTimeoutText("en");

    for (const text of [
      finished,
      finishUnknown,
      daily,
      failing,
      recovered,
      timeout,
    ]) {
      expectEnglish(text);
    }
    expect(finished).toContain("Price dropped");
    expect(daily).toContain("48");
    expect(daily).toContain("00:00 UTC");
    expect(failing).toContain("3");
    expect(failing).toContain("boom");
    expect(failing).toContain("6h");
  });
});
