import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { nowTool } from "../../src/tools/now";

function context(): Context {
  return { abortSignal: undefined } as unknown as Context;
}

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

function at(iso: string) {
  return () => new Date(iso);
}

describe("nowTool", () => {
  it("reports UTC and China time for a fixed instant", async () => {
    const tool = nowTool(at("2026-11-04T14:09:00.000Z"));
    const text = textOf(await tool.execute({}, {} as never, context()));

    expect(text).toContain("2026-11-04");
    expect(text).toContain("22:09");
    expect(text).toContain("星期三");
    expect(text).toContain("UTC+8");
  });

  it("falls back to Asia/Shanghai for an unknown zone", async () => {
    const tool = nowTool(at("2026-11-04T14:09:00.000Z"));
    const text = textOf(
      await tool.execute({ timezone: "Mars/Olympus" }, {} as never, context()),
    );

    expect(text).toContain("Asia/Shanghai");
    expect(text).toContain("22:09");
  });

  it("is marked replay-safe", () => {
    expect(nowTool().replay).toBe("safe");
  });
});
it.each([
  ["UTC", "2026-11-04 14:09 UTC+0"],
  ["America/New_York", "2026-11-04 09:09 UTC-5"],
  ["Asia/Kathmandu", "2026-11-04 19:54 UTC+5:45"],
])("formats %s exactly", async (timezone, expected) => {
  const result = await nowTool(at("2026-11-04T14:09:00Z")).execute({ timezone }, {} as never, context());
  expect(textOf(result)).toContain(expected);
});
it("reports the weekday after crossing midnight", async () => {
  const result = await nowTool(at("2026-11-04T20:09:00Z")).execute({}, {} as never, context());
  expect(textOf(result)).toContain("2026-11-05 04:09 UTC+8（星期四）");
});
it("falls back when Intl is unavailable", async () => {
  const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => { throw new Error("no ICU"); });
  try {
    const result = await nowTool(at("2026-11-04T14:09:00Z")).execute({ timezone: "UTC" }, {} as never, context());
    expect(textOf(result)).toContain("22:09 UTC+8");
    expect(textOf(result)).toContain("无法解析");
  } finally { spy.mockRestore(); }
});
