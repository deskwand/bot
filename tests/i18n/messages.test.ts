import { describe, expect, it } from "vitest";
import { formatTemplate, t } from "../../src/i18n";

describe("t", () => {
  it("returns the English prompt instruction", () => {
    expect(t("en", "prompt.replyLanguage")).toBe(
      "Always reply to the owner in English.",
    );
  });

  it("returns the Chinese prompt instruction", () => {
    expect(t("zh", "prompt.replyLanguage")).toBe("始终用中文回复主人。");
  });
});

describe("formatTemplate", () => {
  it("replaces named placeholders", () => {
    expect(formatTemplate("你好 {name}", { name: "A" })).toBe("你好 A");
  });

  it("keeps unknown placeholders untouched", () => {
    expect(formatTemplate("{x}", {})).toBe("{x}");
  });

  it("does not read prototype properties as parameters", () => {
    expect(formatTemplate("{toString}", {})).toBe("{toString}");
  });
});
