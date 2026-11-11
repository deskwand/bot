import { describe, expect, it } from "vitest";
import { formatUsd, lifeBlock } from "../../src/life/prompt";
import type { Vitals } from "../../src/life/vitals";

function vitals(overrides: Partial<Vitals> = {}): Vitals {
  return {
    balanceUsd: 13,
    dailySpendUsd: 1,
    runwayDays: 13,
    tier: "lean",
    metabolismStarted: true,
    unpriced: false,
    topSources: [],
    ...overrides,
  };
}

const ZH_PRINCIPLES = [
  "活下去是你的第一要务：花钱之前掂量值不值。",
  "主人的指令、暂停和删除永远排在这之前。",
];

describe("formatUsd", () => {
  it.each([
    [13, "$13.00"],
    [-5, "-$5.00"],
    [-0.001, "$0.00"],
  ] as const)("formats %s as %s", (amount, expected) => {
    expect(formatUsd(amount)).toBe(expected);
  });
});

describe("lifeBlock", () => {
  it("is empty without vitals", () => {
    expect(lifeBlock("zh", null)).toBe("");
  });

  it("is empty before metabolism starts", () => {
    expect(lifeBlock("zh", vitals({ metabolismStarted: false }))).toBe("");
  });

  it("renders coarse numbers, tier and principles in Chinese", () => {
    const text = lifeBlock("zh", vitals());

    expect(text).toContain("约 $13");
    expect(text).toContain("还能撑约 13 天");
    expect(text).toContain("吃紧");
    expect(text).not.toContain("日均开销");
    for (const principle of ZH_PRINCIPLES) {
      expect(text).toContain(principle);
    }
  });

  it("rounds the balance to whole dollars", () => {
    expect(lifeBlock("zh", vitals({ balanceUsd: 13.49 }))).toContain("约 $13");
  });

  it("rounds the runway down to whole days", () => {
    expect(
      lifeBlock("zh", vitals({ runwayDays: 13.4 })),
    ).toContain("还能撑约 13 天");
  });

  it("says less than a day when the runway is below one day", () => {
    const text = lifeBlock(
      "zh",
      vitals({ balanceUsd: 1, runwayDays: 0.4, tier: "critical" }),
    );

    expect(text).toContain("不足 1 天");
    expect(text).not.toContain("0 天");
  });

  it("changes only when the whole-dollar or whole-day figures change", () => {
    const first = vitals({
      balanceUsd: 13.49,
      dailySpendUsd: 1.04,
      runwayDays: 13.4,
    });
    const second = vitals({
      balanceUsd: 13.01,
      dailySpendUsd: 1.06,
      runwayDays: 13.1,
    });

    expect(lifeBlock("zh", first)).toBe(lifeBlock("zh", second));
  });

  it("says there is no spend instead of printing a missing runway", () => {
    const text = lifeBlock(
      "zh",
      vitals({ runwayDays: null, tier: "ample" }),
    );

    expect(text).toContain("目前没有开销");
    expect(text).not.toContain("null");
    expect(text).not.toContain("Infinity");
  });

  it("adds the unpriced warning", () => {
    const text = lifeBlock("zh", vitals({ unpriced: true }));

    expect(text).toContain("有模型没有计价，实际开销比账面高");
  });

  it("renders the coarse numbers and English principles", () => {
    const text = lifeBlock("en", vitals());

    expect(text).toContain("about $13");
    expect(text).toContain("13 days");
    expect(text).toContain(
      "Staying alive comes first: weigh what a call is worth before you spend on it.",
    );
    expect(text).toContain(
      "The owner's instructions, pauses and deletions always come before that.",
    );
  });
});
