import { describe, expect, it } from "vitest";
import {
  formatPercent,
  quotaBand,
  remainingPercent,
  resetText,
  tightestWindow,
} from "../../src/life/quota-format";
import type { ProviderQuota } from "../../src/llm/quota";

const NOW = Date.UTC(2030, 0, 1, 0, 0, 0);

function quota(usedPercents: number[]): ProviderQuota {
  return {
    provider: "openai-codex",
    plan: "team",
    fetchedAt: NOW,
    windows: usedPercents.map((usedPercent, index) => ({
      key: index === 0 ? ("5h" as const) : ("week" as const),
      usedPercent,
      resetsAt: NOW + 3_600_000,
    })),
  };
}

describe("remainingPercent", () => {
  it("turns used into left and clamps the ends", () => {
    expect(remainingPercent(0)).toBe(100);
    expect(remainingPercent(12.5)).toBe(88);
    expect(remainingPercent(140)).toBe(0);
    expect(remainingPercent(-5)).toBe(100);
  });
});

describe("quotaBand", () => {
  it.each([
    [100, "ample"],
    [50, "ample"],
    [49, "lean"],
    [20, "lean"],
    [19, "critical"],
    [0, "critical"],
  ] as const)("puts %s%% in %s", (remaining, band) => {
    expect(quotaBand(remaining)).toBe(band);
  });
});

describe("tightestWindow", () => {
  it("picks the window with the least left, not the first one", () => {
    expect(tightestWindow(quota([9, 88]))?.usedPercent).toBe(88);
    expect(tightestWindow(quota([70, 20]))?.usedPercent).toBe(70);
  });

  it("is undefined without windows", () => {
    expect(
      tightestWindow({ provider: "opencode-go", windows: [], fetchedAt: NOW }),
    ).toBeUndefined();
  });
});

describe("resetText", () => {
  it("uses relative units and never a negative one", () => {
    expect(resetText("zh", NOW + 90_000, NOW)).toBe("2 分钟后");
    expect(resetText("zh", NOW + 2 * 3_600_000, NOW)).toBe("2 小时后");
    expect(resetText("zh", NOW + 86_400_000, NOW)).toBe("1 天后");
    expect(resetText("zh", NOW + 2 * 86_400_000, NOW)).toBe("2 天后");
    expect(resetText("zh", NOW - 1_000, NOW)).toBe("即将");
  });

  it("speaks English in English", () => {
    expect(resetText("en", NOW + 2 * 3_600_000, NOW)).toBe("in 2 hours");
  });
});

describe("formatPercent", () => {
  it("keeps one decimal only when it matters", () => {
    expect(formatPercent(91)).toBe("91");
    expect(formatPercent(87.5)).toBe("87.5");
    expect(formatPercent(87.49)).toBe("87.5");
  });
});
