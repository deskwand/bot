import { afterEach, describe, expect, it } from "vitest";
import {
  getClock,
  setClockOverride,
  type Clock,
} from "../../src/butler/notifier";

afterEach(() => {
  setClockOverride(null);
});

describe("getClock", () => {
  it("returns the system clock by default", () => {
    const before = Date.now();
    expect(getClock().now()).toBeGreaterThanOrEqual(before);
    expect(getClock().now()).toBeLessThanOrEqual(Date.now());
  });

  it("returns the test override until it is cleared", () => {
    const clock: Clock = {
      now: () => 42,
      setTimeout: () => 1,
      clearTimeout: () => {},
    };
    setClockOverride(clock);
    expect(getClock()).toBe(clock);
    expect(getClock().now()).toBe(42);

    setClockOverride(null);
    expect(getClock()).not.toBe(clock);
  });
});
