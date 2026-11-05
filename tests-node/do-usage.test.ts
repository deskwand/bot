import { describe, expect, it } from "vitest";
import { parseArgs, readOAuthToken, summarize } from "../scripts/lib/do-usage";

describe("do usage script", () => {
  it("reads the oauth token", () => {
    expect(readOAuthToken('oauth_token = "abc"\nexpiration_time = "x"')).toBe("abc");
    expect(readOAuthToken('api_token = "x"')).toBeNull();
  });

  it("summarizes one day across classes", () => {
    const out = summarize(
      [
        { date: "2026-11-05", namespaceId: "a", rowsWritten: 74_349, rowsRead: 1, activeTime: 1 },
        { date: "2026-11-05", namespaceId: "b", rowsWritten: 22_904, rowsRead: 1, activeTime: 1 },
      ],
      { a: "TaskDO", b: "ButlerDO" },
    );
    expect(out[0].totalWritten).toBe(97_253);
    expect(out[0].pctOfFree).toBeCloseTo(97.253);
    expect(out[0].byClass[0].className).toBe("TaskDO");
  });

  it("parses --objects with --date", () => {
    expect(parseArgs(["--objects", "TaskDO", "--date", "2026-11-05"])).toEqual({
      days: 3,
      objects: { className: "TaskDO", date: "2026-11-05" },
    });
    expect(parseArgs([])).toEqual({ days: 3 });
  });
});
