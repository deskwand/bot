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

  it("renders the numbers, tier and principles in Chinese", () => {
    const text = lifeBlock("zh", vitals());

    expect(text).toContain("13.00");
    expect(text).toContain("1.00");
    expect(text).toContain("13.0");
    expect(text).toContain("吃紧");
    for (const principle of ZH_PRINCIPLES) {
      expect(text).toContain(principle);
    }
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

  it("renders the English principles", () => {
    const text = lifeBlock("en", vitals());

    expect(text).toContain(
      "Staying alive comes first: weigh what a call is worth before you spend on it.",
    );
    expect(text).toContain(
      "The owner's instructions, pauses and deletions always come before that.",
    );
  });
});
