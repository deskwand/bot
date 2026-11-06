import { describe, expect, it } from "vitest";
import {
  MAX_ARTIFACT_BYTES,
  artifactKeySegments,
  artifactNameFromKey,
} from "../src/artifact";

describe("artifactKeySegments", () => {
  it("accepts a three-segment key", () => {
    expect(artifactKeySegments("t1/abc/report.md")).toEqual([
      "t1",
      "abc",
      "report.md",
    ]);
  });

  it("rejects the wrong number of segments", () => {
    expect(artifactKeySegments("t1/abc")).toBeNull();
    expect(artifactKeySegments("t1")).toBeNull();
    expect(artifactKeySegments("t1/abc/x/y")).toBeNull();
    expect(artifactKeySegments("")).toBeNull();
  });

  it("rejects empty, dot and traversal segments", () => {
    expect(artifactKeySegments("t1//x")).toBeNull();
    expect(artifactKeySegments("t1/./x")).toBeNull();
    expect(artifactKeySegments("t1/../x")).toBeNull();
    expect(artifactKeySegments("t1/abc/..")).toBeNull();
  });

  it("rejects separators and control characters inside a segment", () => {
    expect(artifactKeySegments("t1/ab\\c/x")).toBeNull();
    expect(artifactKeySegments("t1/a\u0000b/x")).toBeNull();
    expect(artifactKeySegments("t1/a\u007fb/x")).toBeNull();
  });
});

describe("artifactNameFromKey", () => {
  it("takes the last segment even with spaces and CJK", () => {
    expect(artifactNameFromKey("t1/abc/报告 v1.md")).toBe("报告 v1.md");
  });
});

describe("MAX_ARTIFACT_BYTES", () => {
  it("is 15 MB", () => {
    expect(MAX_ARTIFACT_BYTES).toBe(15 * 1024 * 1024);
  });
});
