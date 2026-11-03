import { describe, expect, it } from "vitest";
import {
  MAX_WAKE_MS,
  MIN_WAKE_MS,
  clampWakeAt,
  failureDelayMs,
  nextUtcMidnight,
  parseDuration,
  utcDay,
} from "../../src/bot/wake";

describe("wake rules", () => {
  it("parses durations", () => {
    expect(parseDuration("90m")).toBe(5_400_000);
    expect(parseDuration(" 1d12h ")).toBe(129_600_000);
    expect(parseDuration("2H")).toBe(7_200_000);
    for (const bad of ["", "abc", "-1h", "1.5h", "0m", "h", "1w"]) {
      expect(parseDuration(bad)).toBeNull();
    }
  });

  it("clamps wake times", () => {
    const now = 1_000_000;
    expect(clampWakeAt(now, now - 1)).toEqual({
      at: now + MIN_WAKE_MS,
      clamped: true,
    });
    expect(clampWakeAt(now, now + 3_600_000)).toEqual({
      at: now + 3_600_000,
      clamped: false,
    });
    expect(clampWakeAt(now, now + MAX_WAKE_MS + 1)).toEqual({
      at: now + MAX_WAKE_MS,
      clamped: true,
    });
  });

  it("backs off failures", () => {
    expect([1, 2, 3, 7].map(failureDelayMs)).toEqual([
      900_000, 3_600_000, 21_600_000, 21_600_000,
    ]);
  });

  it("computes UTC days", () => {
    const t = Date.UTC(2026, 10, 3, 23, 59);
    expect(utcDay(t)).toBe("2026-11-03");
    expect(nextUtcMidnight(t)).toBe(Date.UTC(2026, 10, 4));
  });
});
