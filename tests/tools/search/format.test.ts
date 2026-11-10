import { describe, expect, it } from "vitest";
import { formatResults, truncate } from "../../../src/tools/search/format";

describe("formatResults", () => {
  it("formats each result as title, url and snippet", () => {
    const text = formatResults([
      { title: "A", url: "https://a", snippet: "x" },
      { title: "B", url: "https://b", snippet: "y" },
    ]);

    expect(text).toBe("A\nhttps://a\nx\n\nB\nhttps://b\ny");
  });

  it("outputs only the snippet when title and url are empty", () => {
    expect(formatResults([{ title: "", url: "", snippet: "raw" }])).toBe("raw");
  });

  it("returns an empty string for no results", () => {
    expect(formatResults([])).toBe("");
  });
});

describe("truncate", () => {
  it("cuts long text at the limit and appends the marker", () => {
    const text = truncate("a".repeat(20_001));
    const marker = "\n\n[已截断]";

    expect(text.endsWith(marker)).toBe(true);
    expect(text).toHaveLength(20_000 + marker.length);
  });

  it("leaves short text untouched", () => {
    expect(truncate("short")).toBe("short");
  });
});
