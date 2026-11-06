import { describe, expect, it } from "vitest";
import {
  MAX_WAKE_MS,
  MIN_WAKE_MS,
  clampWakeAt,
  failureDelayMs,
  formatDuration,
  nextUtcMidnight,
  parseDuration,
  utcDay,
  wakeCeilingMs,
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

  it("clamps to a custom max", () => {
    expect(clampWakeAt(0, 10 * 3_600_000, 3_600_000)).toEqual({
      at: 3_600_000,
      clamped: true,
    });
  });

  it("clamp with max equal to min", () => {
    expect(clampWakeAt(0, 3_600_000, 300_000)).toEqual({
      at: 300_000,
      clamped: true,
    });
  });

  it("wakeCeilingMs caps at 30 days", () => {
    expect(wakeCeilingMs(86_400_000)).toBe(86_400_000);
    expect(wakeCeilingMs(40 * 86_400_000)).toBe(2_592_000_000);
  });

  it("backs off failures", () => {
    expect(failureDelayMs(1, 300_000)).toBe(900_000);
    expect(failureDelayMs(2, 300_000)).toBe(3_600_000);
    expect(failureDelayMs(3, 3_600_000)).toBe(21_600_000);
    expect(failureDelayMs(5, 2 * 86_400_000)).toBe(2 * 86_400_000);
  });

  it("formats durations in the largest whole unit", () => {
    expect(formatDuration(21_600_000)).toBe("6h");
    expect(formatDuration(5_400_000)).toBe("90m");
    expect(formatDuration(86_400_000)).toBe("1d");
  });

  it("computes UTC days", () => {
    const t = Date.UTC(2026, 10, 3, 23, 59);
    expect(utcDay(t)).toBe("2026-11-03");
    expect(nextUtcMidnight(t)).toBe(Date.UTC(2026, 10, 4));
  });
});
