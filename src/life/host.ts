import type { HostSnapshot } from "../sandbox/host";

export type Band = "ample" | "lean" | "critical";

export type HostBands = {
  disk: Band | null;
  mem: Band | null;
  load: Band | null;
  cgroup: Band | null;
};

/** A snapshot older than this never reaches the prompt: it may lie. */
export const HOST_MAX_AGE_MS = 10 * 60_000;

export const AVAILABILITY_AMPLE_PERCENT = 20;
export const AVAILABILITY_LEAN_PERCENT = 5;
export const CGROUP_AMPLE_RATIO = 0.8;
export const CGROUP_CRITICAL_RATIO = 0.9;
export const LOAD_LEAN_RATIO = 1.5;
export const LOAD_CRITICAL_RATIO = 3;

function percent(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

/** Free space and free memory share one scale: more is better. */
function availabilityBand(value: number | null): Band | null {
  if (value === null) return null;
  if (value >= AVAILABILITY_AMPLE_PERCENT) return "ample";
  if (value >= AVAILABILITY_LEAN_PERCENT) return "lean";
  return "critical";
}

function ratioBand(
  value: number | null,
  lean: number,
  critical: number,
): Band | null {
  if (value === null) return null;
  if (value >= critical) return "critical";
  if (value >= lean) return "lean";
  return "ample";
}

export function diskPercent(snapshot: HostSnapshot): number | null {
  let tightest: number | null = null;
  for (const disk of snapshot.disk ?? []) {
    const value = percent(disk.freeBytes, disk.totalBytes);
    if (value === null) continue;
    tightest = tightest === null ? value : Math.min(tightest, value);
  }
  return tightest;
}

export function memPercent(snapshot: HostSnapshot): number | null {
  const mem = snapshot.mem;
  if (mem === undefined) return null;
  if (mem.totalBytes === undefined || mem.availableBytes === undefined) {
    return null;
  }
  return percent(mem.availableBytes, mem.totalBytes);
}

export function loadRatio(snapshot: HostSnapshot): number | null {
  const cpu = snapshot.cpu;
  if (cpu === undefined || cpu.load1 === undefined) return null;
  if (!Number.isFinite(cpu.cores) || cpu.cores < 1) return null;
  return cpu.load1 / cpu.cores;
}

function cgroupRatio(snapshot: HostSnapshot): number | null {
  const cgroup = snapshot.mem?.cgroup;
  if (cgroup === undefined) return null;
  const value = percent(cgroup.usedBytes, cgroup.limitBytes);
  return value === null ? null : value / 100;
}

export function hostBands(snapshot: HostSnapshot): HostBands {
  const cgroup = cgroupRatio(snapshot);
  return {
    disk: availabilityBand(diskPercent(snapshot)),
    mem: availabilityBand(memPercent(snapshot)),
    load: ratioBand(loadRatio(snapshot), LOAD_LEAN_RATIO, LOAD_CRITICAL_RATIO),
    cgroup:
      cgroup === null
        ? null
        : cgroup >= CGROUP_CRITICAL_RATIO
          ? "critical"
          : cgroup >= CGROUP_AMPLE_RATIO
            ? "lean"
            : "ample",
  };
}

/**
 * Floor to a 5% step. Rounding up would print "5%" beside a "见底" band, and
 * stepping at all keeps the prompt prefix stable when a number wobbles.
 */
export function percentStep(value: number): number {
  const clamped = Math.max(0, Math.min(100, value));
  return Math.floor(clamped / 5) * 5;
}

/** 3.1 for 3.1 GiB — the tool shows exact numbers, so one decimal is enough. */
export function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}
