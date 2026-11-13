import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type DiskUsage = { usedBytes: number; limitBytes: number };

export type DiskProbe = { usage(fresh?: boolean): Promise<DiskUsage> };

const CACHE_MS = 10_000;

/**
 * Every response carries the usage, and a busy task can issue hundreds of
 * commands a minute, so `du` is cached. This is an observation, not a quota:
 * a shell can still write past the limit.
 */
export function createDiskProbe(
  dir: string,
  limitBytes: number,
  clock: () => number = Date.now,
): DiskProbe {
  let cached: { at: number; usedBytes: number } | null = null;
  return {
    async usage(fresh = false): Promise<DiskUsage> {
      const now = clock();
      if (!fresh && cached !== null && now - cached.at < CACHE_MS) {
        return { usedBytes: cached.usedBytes, limitBytes };
      }
      let usedBytes = 0;
      try {
        // `du -sk`, not `du -sb`: BSD du (the macOS dev machine) has no -b, and
        // a 1 KiB granularity is plenty for a value that is only reported.
        const { stdout } = await run("du", ["-sk", dir]);
        const kib = Number.parseInt(stdout.split("\t")[0] ?? "", 10);
        if (Number.isFinite(kib) && kib > 0) usedBytes = kib * 1024;
      } catch {
        usedBytes = 0;
      }
      cached = { at: now, usedBytes };
      return { usedBytes, limitBytes };
    },
  };
}
