import { describe, expect, it } from "vitest";
import {
  HOST_MAX_AGE_MS,
  diskPercent,
  hostBands,
  loadRatio,
  memPercent,
  percentStep,
} from "../../src/life/host";
import type { HostSnapshot } from "../../src/sandbox/host";

const GIB = 1024 ** 3;

function snapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    sampledAt: 1_763_000_000_000,
    cpu: { cores: 4, load1: 0.4 },
    mem: { totalBytes: 8 * GIB, availableBytes: 4 * GIB },
    disk: [{ path: "/", totalBytes: 100 * GIB, freeBytes: 50 * GIB }],
    ...overrides,
  };
}

describe("percentStep", () => {
  it.each([
    [45.28, 45],
    [4.9, 0],
    [0, 0],
    [100, 100],
    [104, 100],
  ] as const)("floors %s to a 5%% step as %s", (input, expected) => {
    expect(percentStep(input)).toBe(expected);
  });
});

describe("diskPercent", () => {
  it("reports the tightest disk", () => {
    expect(
      diskPercent({
        sampledAt: 0,
        disk: [
          { path: "/", totalBytes: 100, freeBytes: 80 },
          { path: "/sandbox", totalBytes: 100, freeBytes: 4 },
        ],
      }),
    ).toBe(4);
  });

  it("is null without disks", () => {
    expect(diskPercent({ sampledAt: 0 })).toBeNull();
  });
});

describe("memPercent and loadRatio", () => {
  it("is null when memory is incomplete", () => {
    expect(memPercent({ sampledAt: 0, mem: { totalBytes: 100 } })).toBeNull();
  });

  it("divides load by cores", () => {
    expect(loadRatio(snapshot())).toBeCloseTo(0.1);
    expect(loadRatio({ sampledAt: 0, cpu: { cores: 0 } })).toBeNull();
    expect(loadRatio({ sampledAt: 0, cpu: { cores: 4 } })).toBeNull();
  });
});

describe("hostBands", () => {
  it.each([
    [20, "ample"],
    [19.9, "lean"],
    [5, "lean"],
    [4.9, "critical"],
  ] as const)("puts %s%% free disk in the %s band", (freePercent, expected) => {
    const total = 1000;
    const bands = hostBands(
      snapshot({
        disk: [{ path: "/", totalBytes: total, freeBytes: (total * freePercent) / 100 }],
      }),
    );

    expect(bands.disk).toBe(expected);
  });

  it.each([
    [1.49, "ample"],
    [1.5, "lean"],
    [2.99, "lean"],
    [3, "critical"],
  ] as const)("puts a load of %s per core in the %s band", (ratio, expected) => {
    const bands = hostBands(
      snapshot({
        cpu: { cores: 4, load1: ratio * 4 },
        mem: undefined,
        disk: undefined,
      }),
    );

    expect(bands.load).toBe(expected);
  });

  it.each([
    [0.799, "ample"],
    [0.8, "lean"],
    [0.899, "lean"],
    [0.9, "critical"],
  ] as const)("puts %s cgroup usage in the %s band", (ratio, expected) => {
    const bands = hostBands(
      snapshot({ mem: { cgroup: { limitBytes: 1000, usedBytes: ratio * 1000 } } }),
    );

    expect(bands.cgroup).toBe(expected);
  });

  it("bands the cgroup usage and leaves it null when unset", () => {
    const tight = hostBands(
      snapshot({ mem: { cgroup: { limitBytes: 1000, usedBytes: 950 } } }),
    );
    expect(tight.cgroup).toBe("critical");
    expect(hostBands(snapshot()).cgroup).toBeNull();
  });

  it("leaves every band null for an empty snapshot", () => {
    expect(hostBands({ sampledAt: 0 })).toEqual({
      disk: null,
      mem: null,
      load: null,
      cgroup: null,
    });
  });

  it("keeps the max age at ten minutes", () => {
    expect(HOST_MAX_AGE_MS).toBe(600_000);
  });
});
