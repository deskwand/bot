import { describe, expect, it } from "vitest";
import {
  botDailyLimitText,
  botFinishedText,
  botPausedText,
  botRunTimeoutText,
} from "../../src/bot/owner-copy";

const HAN = /\p{Script=Han}/u;

function expectEnglish(text: string): void {
  expect(text).not.toMatch(HAN);
}

describe("bot notices", () => {
  it("keeps the Chinese copy", () => {
    expect(botFinishedText("zh", "价格哨兵", "价格已降到目标")).toBe(
      "🏁 价格哨兵 已结束，不会再唤醒（原因：价格已降到目标）",
    );
    expect(botFinishedText("zh", "价格哨兵", null)).toBe(
      "🏁 价格哨兵 已结束，不会再唤醒（原因：未说明）",
    );
    expect(botDailyLimitText("zh", "价格哨兵", 48)).toBe(
      "⏸ 价格哨兵 今日唤醒已达 48 次，推迟到明天 00:00 UTC",
    );
    expect(botPausedText("zh", "价格哨兵", 3, "boom")).toBe(
      "⚠️ 价格哨兵 已暂停：连续 3 次失败（最近原因：boom）",
    );
    expect(botRunTimeoutText("zh")).toBe("运行超过 24 小时，已取消");
  });

  it("is English in en", () => {
    const finished = botFinishedText("en", "Price scout", "Price dropped");
    const finishUnknown = botFinishedText("en", "Price scout", null);
    const daily = botDailyLimitText("en", "Price scout", 48);
    const paused = botPausedText("en", "Price scout", 3, "boom");
    const timeout = botRunTimeoutText("en");

    for (const text of [finished, finishUnknown, daily, paused, timeout]) {
      expectEnglish(text);
    }
    expect(finished).toContain("Price scout");
    expect(finished).toContain("Price dropped");
    expect(daily).toContain("Price scout");
    expect(daily).toContain("48");
    expect(daily).toContain("00:00 UTC");
    expect(paused).toContain("Price scout");
    expect(paused).toContain("3");
    expect(paused).toContain("boom");
  });
});
