import { describe, expect, it } from "vitest";
import { readHostSnapshot, type HostProbeDeps } from "../container/sandbox/host";

const NOW = 1_763_000_000_000;

function deps(overrides: Partial<HostProbeDeps> = {}): HostProbeDeps {
  const files: Record<string, string> = {
    "/proc/loadavg": "1.24 1.10 0.90 2/512 12345\n",
    "/proc/meminfo":
      "MemTotal:        8176880 kB\nMemFree:          102400 kB\nMemAvailable:    3027343 kB\n",
    "/proc/uptime": "812344.55 3200000.00\n",
    "/sys/fs/cgroup/memory.max": "2147483648\n",
    "/sys/fs/cgroup/memory.current": "1180000000\n",
  };
  return {
    readText: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    statfs: async () => ({ bsize: 4096, blocks: 64_697_265, bavail: 29_052_734 }),
    cores: () => 4,
    now: () => NOW,
    sandboxDir: "/sandbox",
    ...overrides,
  };
}

describe("readHostSnapshot", () => {
  it("reads load, memory, cgroup, uptime and both disks", async () => {
    const snapshot = await readHostSnapshot(deps());

    expect(snapshot).toEqual({
      sampledAt: NOW,
      cpu: { cores: 4, load1: 1.24 },
      mem: {
        totalBytes: 8_176_880 * 1024,
        availableBytes: 3_027_343 * 1024,
        cgroup: { limitBytes: 2_147_483_648, usedBytes: 1_180_000_000 },
      },
      disk: [
        { path: "/", totalBytes: 4096 * 64_697_265, freeBytes: 4096 * 29_052_734 },
        {
          path: "/sandbox",
          totalBytes: 4096 * 64_697_265,
          freeBytes: 4096 * 29_052_734,
        },
      ],
    });
  });

  it("omits memory it cannot read instead of reporting zero", async () => {
    const snapshot = await readHostSnapshot(
      deps({
        readText: async (path) => {
          if (path === "/proc/meminfo" || path === "/sys/fs/cgroup/memory.max") {
            throw new Error("ENOENT");
          }
          return "1.00 0.50 0.25 1/100 999\n";
        },
      }),
    );

    expect(snapshot?.mem).toBeUndefined();
    expect(snapshot?.cpu).toEqual({ cores: 4, load1: 1 });
  });

  it("treats an unlimited cgroup as no cgroup", async () => {
    const snapshot = await readHostSnapshot(
      deps({
        readText: async (path) => {
          if (path === "/sys/fs/cgroup/memory.max") return "max\n";
          return "MemTotal: 1000 kB\nMemAvailable: 400 kB\n";
        },
      }),
    );

    expect(snapshot?.mem).toEqual({
      totalBytes: 1000 * 1024,
      availableBytes: 400 * 1024,
    });
  });

  it("keeps the core count when only loadavg is unreadable", async () => {
    const snapshot = await readHostSnapshot(
      deps({
        readText: async (path) => {
          if (path === "/proc/loadavg") throw new Error("ENOENT");
          if (path === "/proc/meminfo") return "MemTotal: 1000 kB\nMemAvailable: 400 kB\n";
          throw new Error("ENOENT");
        },
      }),
    );

    expect(snapshot?.cpu).toEqual({ cores: 4 });
  });

  it("drops the cpu block when there are no cores", async () => {
    const snapshot = await readHostSnapshot(deps({ cores: () => 0 }));

    expect(snapshot?.cpu).toBeUndefined();
    expect(snapshot?.mem).toBeDefined();
  });

  it("omits a disk whose statfs fails", async () => {
    const snapshot = await readHostSnapshot(
      deps({
        statfs: async (path) => {
          if (path === "/sandbox") throw new Error("EACCES");
          return { bsize: 4096, blocks: 100, bavail: 25 };
        },
      }),
    );

    expect(snapshot?.disk).toEqual([
      { path: "/", totalBytes: 409_600, freeBytes: 102_400 },
    ]);
  });

  it("returns null when nothing can be read", async () => {
    const snapshot = await readHostSnapshot(
      deps({
        readText: async () => {
          throw new Error("ENOENT");
        },
        statfs: async () => {
          throw new Error("EACCES");
        },
        cores: () => 0,
      }),
    );

    expect(snapshot).toBeNull();
  });

  it("counts only the free space a non-root user can use", async () => {
    const snapshot = await readHostSnapshot(
      deps({ statfs: async () => ({ bsize: 4096, blocks: 100, bavail: 25 }) }),
    );

    // bavail (25) * 4096, not bfree — the root reserve is not hers.
    expect(snapshot?.disk?.[0]?.freeBytes).toBe(102_400);
  });
});
