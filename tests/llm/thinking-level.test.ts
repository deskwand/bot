import { describe, expect, it } from "vitest";
import { defaultLevelFrom } from "../../src/llm/thinking-level";

describe("defaultLevelFrom", () => {
  it("prefers medium when the model offers it", () => {
    expect(
      defaultLevelFrom(["off", "minimal", "low", "medium", "high"]),
    ).toBe("medium");
    expect(
      defaultLevelFrom(["off", "minimal", "low", "medium", "high", "xhigh"]),
    ).toBe("medium");
    expect(defaultLevelFrom(["low", "medium", "high"])).toBe("medium");
  });

  it("takes the highest level below max", () => {
    // The three-level sets most providers ship: low, high, max.
    expect(defaultLevelFrom(["low", "high", "max"])).toBe("high");
    expect(defaultLevelFrom(["off", "high", "max"])).toBe("high");
    // Two-level sets must not collapse to the lowest tier: that would make a
    // model with more levels dumber than one with fewer.
    expect(defaultLevelFrom(["off", "low", "high"])).toBe("high");
    expect(defaultLevelFrom(["low", "high"])).toBe("high");
    expect(defaultLevelFrom(["off", "minimal", "high"])).toBe("high");
    expect(defaultLevelFrom(["off", "high"])).toBe("high");
  });

  it("falls back to off when thinking cannot be tuned", () => {
    expect(defaultLevelFrom(["off"])).toBe("off");
    expect(defaultLevelFrom([])).toBe("off");
  });

  it("uses max only when max is the only level left", () => {
    expect(defaultLevelFrom(["max"])).toBe("max");
    expect(defaultLevelFrom(["off", "max"])).toBe("max");
    expect(defaultLevelFrom(["low", "max"])).toBe("low");
  });
});
