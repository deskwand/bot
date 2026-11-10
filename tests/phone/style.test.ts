import { describe, expect, it } from "vitest";
import { t } from "../../src/i18n";
import { phoneRules } from "../../src/phone/style";

describe("phoneRules", () => {
  it("includes the budget and drops the fragment rule for one-shot messages", () => {
    const rules = phoneRules("zh", { conversational: false });

    expect(rules).toContain(t("zh", "phone.rulesTitle"));
    expect(rules).toContain("300");
    expect(rules).not.toContain(t("zh", "phone.fragmentRule"));
  });

  it("adds the fragment rule to conversational rules", () => {
    const rules = phoneRules("zh", { conversational: true });

    expect(rules).toContain("300");
    expect(rules).toContain(t("zh", "phone.fragmentRule"));
  });

  it("uses the English budget", () => {
    expect(phoneRules("en", { conversational: false })).toContain("600");
  });
});
