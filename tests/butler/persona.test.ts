import { describe, expect, it } from "vitest";
import { persona } from "../../src/butler/persona";

describe("persona", () => {
  it("says how the butler talks", () => {
    const text = persona("zh", "微信");
    expect(text).toContain("第一人称");
    expect(text).toContain("不说「任务 #3 已完成」");
    expect(text).toContain("不用【】");
    expect(text).toContain("微信");
  });

  it("has an English version", () => {
    expect(persona("en", null)).toMatch(/first person/i);
  });
});
