import { describe, expect, it, vi } from "vitest";
import { t } from "../../src/i18n";
import {
  CODE_BLOCK_MAX_LINES,
  COMPRESS_TIMEOUT_MS,
  PHONE_BUDGET,
  fitForPhone,
  phoneViolation,
  type PhoneFitDeps,
} from "../../src/phone/fit";

const artifact = { name: "全文.md", key: "phone/abc/全文.md" };

function deps(overrides: Partial<PhoneFitDeps> = {}): PhoneFitDeps {
  return {
    complete: vi.fn(async () => "短结论"),
    saveOriginal: vi.fn(async () => artifact),
    ...overrides,
  };
}

describe("phoneViolation", () => {
  it("uses the locale budget in code points", () => {
    expect(PHONE_BUDGET).toEqual({ zh: 300, en: 600 });
    expect(phoneViolation("汉".repeat(301), "zh")).toBe("length");
    expect(phoneViolation("汉".repeat(300), "zh")).toBeNull();
    expect(phoneViolation("a".repeat(600), "en")).toBeNull();
    expect(phoneViolation("a".repeat(601), "en")).toBe("length");
  });

  it("flags a Markdown table", () => {
    const text = "结论\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(phoneViolation(text, "zh")).toBe("format");
  });

  it("flags multiple headings", () => {
    expect(phoneViolation("## 一\n\n正文\n\n## 二", "zh")).toBe("format");
  });

  it("flags a code block longer than the limit", () => {
    const lines = Array.from(
      { length: CODE_BLOCK_MAX_LINES + 1 },
      (_, index) => `line ${index + 1}`,
    );
    expect(phoneViolation(["```", ...lines, "```"].join("\n"), "zh")).toBe(
      "format",
    );
    expect(
      phoneViolation(
        ["```", ...lines.slice(1), "```"].join("\n"),
        "zh",
      ),
    ).toBeNull();
  });

  it("prefers length over format", () => {
    const text = `${"汉".repeat(301)}\n\n| a | b |\n| --- | --- |`;
    expect(phoneViolation(text, "zh")).toBe("length");
  });
});

describe("fitForPhone", () => {
  it("passes a compliant message through without calling complete", async () => {
    const complete = vi.fn(async () => "should not be used");
    const saveOriginal = vi.fn(async () => artifact);

    const result = await fitForPhone("短答案", "zh", {
      complete,
      saveOriginal,
    });

    expect(result).toEqual({ text: "短答案", attachments: [] });
    expect(complete).not.toHaveBeenCalled();
    expect(saveOriginal).not.toHaveBeenCalled();
  });

  it("compresses an over-long message and attaches the original", async () => {
    const original = "汉".repeat(400);
    const complete = vi.fn(async () => "短结论");
    const saveOriginal = vi.fn(async () => artifact);

    const result = await fitForPhone(original, "zh", {
      complete,
      saveOriginal,
    });

    expect(result.text).toBe("短结论");
    expect(result.attachments).toEqual([artifact]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      t("zh", "phone.compressSystem"),
      original,
      expect.any(AbortSignal),
    );
    expect(saveOriginal).toHaveBeenCalledWith(original);
  });

  it("compresses a format-only violation without attaching", async () => {
    const original = "结论\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
    const complete = vi.fn(async () => "结论：一对");
    const saveOriginal = vi.fn(async () => artifact);

    const result = await fitForPhone(original, "zh", {
      complete,
      saveOriginal,
    });

    expect(result.text).toBe("结论：一对");
    expect(result.attachments).toEqual([]);
    expect(saveOriginal).not.toHaveBeenCalled();
  });

  it("keeps a format-only message unchanged when compression fails", async () => {
    const original = "结论\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
    const originalArtifact = vi.fn(async () => artifact);

    const result = await fitForPhone(original, "zh", {
      complete: async () => {
        throw new Error("quota");
      },
      saveOriginal: originalArtifact,
    });

    expect(result.text).toBe(original);
    expect(result.attachments).toEqual([]);
    expect(originalArtifact).not.toHaveBeenCalled();
  });

  it("falls back to truncation when complete throws", async () => {
    const original = "汉".repeat(400);
    const complete = vi.fn(async () => {
      throw new Error("quota");
    });
    const saveOriginal = vi.fn(async () => artifact);

    const result = await fitForPhone(original, "zh", {
      complete,
      saveOriginal,
    });

    expect([...result.text].length).toBeLessThanOrEqual(PHONE_BUDGET.zh);
    expect(result.text.endsWith(t("zh", "phone.truncatedSuffix"))).toBe(true);
    expect(result.attachments).toEqual([artifact]);
  });

  it("falls back to truncation when the compressed text is still too long", async () => {
    const original = "汉".repeat(400);
    const complete = vi.fn(async () => "汉".repeat(350));

    const result = await fitForPhone(original, "zh", {
      complete,
      saveOriginal: async () => artifact,
    });

    expect([...result.text].length).toBeLessThanOrEqual(PHONE_BUDGET.zh);
    expect(result.text.endsWith(t("zh", "phone.truncatedSuffix"))).toBe(true);
    expect(result.attachments).toEqual([artifact]);
  });

  it("truncates a single long paragraph by code point", async () => {
    const original = "汉".repeat(400);
    const result = await fitForPhone(original, "zh", {
      complete: async () => {
        throw new Error("quota");
      },
      saveOriginal: async () => artifact,
    });

    const suffix = t("zh", "phone.truncatedSuffix");
    expect(result.text).toBe(
      `${"汉".repeat(PHONE_BUDGET.zh - [...suffix].length)}${suffix}`,
    );
  });

  it("accumulates whole paragraphs until the budget is reached", async () => {
    const original = `${"甲".repeat(100)}\n\n${"乙".repeat(100)}\n\n${"丙".repeat(100)}`;
    const result = await fitForPhone(original, "zh", {
      complete: async () => {
        throw new Error("quota");
      },
      saveOriginal: async () => artifact,
    });

    const suffix = t("zh", "phone.truncatedSuffix");
    expect(result.text).toBe(
      `${"甲".repeat(100)}\n\n${"乙".repeat(100)}${suffix}`,
    );
  });

  it("keeps the full text when saveOriginal throws", async () => {
    const original = "汉".repeat(400);
    const result = await fitForPhone(original, "zh", {
      complete: async () => {
        throw new Error("quota");
      },
      saveOriginal: async () => {
        throw new Error("r2 down");
      },
    });

    expect(result.text).toBe(original);
    expect(result.attachments).toEqual([]);
  });

  it("keeps the compressed text when saveOriginal throws", async () => {
    const original = "汉".repeat(400);
    const result = await fitForPhone(original, "zh", {
      complete: async () => "短结论",
      saveOriginal: async () => {
        throw new Error("r2 down");
      },
    });

    expect(result.text).toBe("短结论");
    expect(result.attachments).toEqual([]);
  });

  it("exposes a fifteen second compression timeout", () => {
    expect(COMPRESS_TIMEOUT_MS).toBe(15_000);
  });
});
