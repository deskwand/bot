import { describe, expect, it } from "vitest";
import {
  METHODS_LIMIT,
  MEMORY_DOC,
  MEMORY_LIMIT,
  RULES_DOC,
  RULES_LIMIT,
  checkDocWrite,
  isMethodDoc,
} from "../../src/bot/docs";

describe("checkDocWrite", () => {
  it("trims the name and content of a method document", () => {
    expect(
      checkDocWrite([], " 方法 ", " 先看主站 ", { allowRules: false }),
    ).toEqual({
      ok: true,
      name: "方法",
      content: "先看主站",
      used: 4,
      limit: METHODS_LIMIT,
    });
  });

  it("treats blank content as a delete", () => {
    expect(
      checkDocWrite([], "方法", " \n\t ", { allowRules: false }),
    ).toEqual({
      ok: true,
      name: "方法",
      content: null,
      used: 0,
      limit: METHODS_LIMIT,
    });
  });

  it("rejects invalid names", () => {
    for (const name of ["   ", "x".repeat(41), "a\nb", "a<<<b", "a>>>b"]) {
      const result = checkDocWrite([], name, "内容", { allowRules: true });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a rejection");
      expect(result.message).toContain("文档名");
    }
  });

  it("only lets owners write rules", () => {
    const rejected = checkDocWrite([], RULES_DOC, "x", { allowRules: false });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected a rejection");
    expect(rejected.message).toContain("propose_rules");

    expect(
      checkDocWrite([], RULES_DOC, "x".repeat(RULES_LIMIT), {
        allowRules: true,
      }),
    ).toEqual({
      ok: true,
      name: RULES_DOC,
      content: "x".repeat(RULES_LIMIT),
      used: RULES_LIMIT,
      limit: RULES_LIMIT,
    });

    const tooLong = checkDocWrite([], RULES_DOC, "x".repeat(RULES_LIMIT + 1), {
      allowRules: true,
    });
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) throw new Error("expected a rejection");
    expect(tooLong.message).toContain("2001");
    expect(tooLong.message).toContain("2000");
  });

  it("caps memory at its own limit", () => {
    expect(
      checkDocWrite([], MEMORY_DOC, "x".repeat(MEMORY_LIMIT), {
        allowRules: false,
      }).ok,
    ).toBe(true);
    expect(
      checkDocWrite([], MEMORY_DOC, "x".repeat(MEMORY_LIMIT + 1), {
        allowRules: false,
      }).ok,
    ).toBe(false);
  });

  it("counts methods together and deducts the replaced document", () => {
    const docs = [
      { name: "A", content: "x".repeat(5000) },
      { name: "B", content: "y".repeat(500) },
    ];

    expect(checkDocWrite(docs, "A", "x".repeat(5500), { allowRules: false })).toEqual(
      {
        ok: true,
        name: "A",
        content: "x".repeat(5500),
        used: METHODS_LIMIT,
        limit: METHODS_LIMIT,
      },
    );

    expect(checkDocWrite(docs, "C", "z".repeat(501), { allowRules: false }).ok).toBe(
      false,
    );
  });

  it("does not count rules or memory as methods", () => {
    const docs = [
      { name: RULES_DOC, content: "x".repeat(2000) },
      { name: MEMORY_DOC, content: "y".repeat(2200) },
    ];
    expect(checkDocWrite(docs, "方法", "z".repeat(6000), { allowRules: false })).toEqual(
      {
        ok: true,
        name: "方法",
        content: "z".repeat(6000),
        used: METHODS_LIMIT,
        limit: METHODS_LIMIT,
      },
    );

    expect(isMethodDoc(RULES_DOC)).toBe(false);
    expect(isMethodDoc(MEMORY_DOC)).toBe(false);
    expect(isMethodDoc("数据源")).toBe(true);
  });
});
