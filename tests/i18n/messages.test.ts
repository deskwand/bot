import { describe, expect, it } from "vitest";
import validConfig from "../../contracts/fixtures/config-valid.json";
import { formatTemplate, ownerLocale, t, tryT } from "../../src/i18n";

function envWith(config: unknown): Env {
  return { DESKWAND_CONFIG: config } as unknown as Env;
}

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

describe("ownerLocale", () => {
  it("returns the configured locale", () => {
    expect(ownerLocale(envWith({ ...validConfig, locale: "en" }))).toBe("en");
  });

  it("falls back to zh", () => {
    expect(ownerLocale(envWith(undefined))).toBe("zh");
    expect(ownerLocale(envWith("not json"))).toBe("zh");
  });
});

describe("tryT", () => {
  it("returns undefined for unknown keys", () => {
    expect(tryT("en", "missing.key")).toBeUndefined();
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
