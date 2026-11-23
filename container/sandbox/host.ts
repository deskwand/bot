import { readFile, statfs } from "node:fs/promises";
import { availableParallelism } from "node:os";

export type HostDisk = { path: string; totalBytes: number; freeBytes: number };

export type HostSnapshot = {
  sampledAt: number;
  cpu?: { cores: number; load1?: number };
  mem?: {
    totalBytes?: number;
    availableBytes?: number;
    cgroup?: { limitBytes: number; usedBytes: number };
  };
  disk?: HostDisk[];
};

export type HostProbe = () => Promise<HostSnapshot | null>;

export type HostProbeDeps = {
  readText: (path: string) => Promise<string>;
  statfs: (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
  cores: () => number;
  now: () => number;
  sandboxDir: string;
};

const LOADAVG = "/proc/loadavg";
const MEMINFO = "/proc/meminfo";
const MEMORY_MAX = "/sys/fs/cgroup/memory.max";
const MEMORY_CURRENT = "/sys/fs/cgroup/memory.current";

/** A failed read is an absent value, never a zero: "0% free" means "full". */
async function readText(deps: HostProbeDeps, path: string): Promise<string | null> {
  try {
    return await deps.readText(path);
  } catch {
    return null;
  }
}

function parseNumber(
  text: string | null,
  parse: (text: string) => number,
): number | null {
  if (text === null) return null;
  const value = parse(text);
  return Number.isFinite(value) ? value : null;
}

function kib(meminfo: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s*kB$`, "m").exec(meminfo);
  if (match === null) return null;
  const amount = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(amount) ? amount * 1024 : null;
}

async function diskUsage(
  deps: HostProbeDeps,
  path: string,
): Promise<HostDisk | null> {
  try {
    const stats = await deps.statfs(path);
    const blockSize = Number(stats.bsize);
    const blocks = Number(stats.blocks);
    const available = Number(stats.bavail);
    if (!Number.isFinite(blockSize) || blockSize <= 0) return null;
    if (!Number.isFinite(blocks) || blocks <= 0) return null;
    if (!Number.isFinite(available) || available < 0) return null;
    return {
      path,
      totalBytes: blockSize * blocks,
      // bavail, not bfree: the root-only reserve is not room she can write to.
      freeBytes: blockSize * available,
    };
  } catch {
    return null;
  }
}

export async function readHostSnapshot(
  deps: HostProbeDeps,
): Promise<HostSnapshot | null> {
  const snapshot: HostSnapshot = { sampledAt: deps.now() };

  // Independent reads, one wall clock: nothing here depends on anything else
  // in the batch, and every read is already guarded.
  const [loadavg, meminfo, memoryMax, memoryCurrent, disks] = await Promise.all([
    readText(deps, LOADAVG),
    readText(deps, MEMINFO),
    readText(deps, MEMORY_MAX),
    readText(deps, MEMORY_CURRENT),
    Promise.all(["/", deps.sandboxDir].map((path) => diskUsage(deps, path))),
  ]);

  const cores = deps.cores();
  if (Number.isInteger(cores) && cores > 0) {
    const load1 = parseNumber(loadavg, (text) =>
      Number.parseFloat(text.trim().split(/\s+/)[0] ?? ""),
    );
    snapshot.cpu = load1 === null ? { cores } : { cores, load1 };
  }

  if (meminfo !== null) {
    const totalBytes = kib(meminfo, "MemTotal");
    const availableBytes = kib(meminfo, "MemAvailable");
    if (totalBytes !== null || availableBytes !== null) {
      snapshot.mem = {
        ...(totalBytes === null ? {} : { totalBytes }),
        ...(availableBytes === null ? {} : { availableBytes }),
      };
    }
  }

  // cgroup v2 only. `memory.max` is the literal "max" when nothing limits it,
  // and parseInt turns that into NaN, which is exactly the omission we want.
  const limitBytes = parseNumber(memoryMax, (text) =>
    Number.parseInt(text.trim(), 10),
  );
  const usedBytes = parseNumber(memoryCurrent, (text) =>
    Number.parseInt(text.trim(), 10),
  );
  if (limitBytes !== null && usedBytes !== null) {
    snapshot.mem = { ...snapshot.mem, cgroup: { limitBytes, usedBytes } };
  }

  // No dedupe by device: `/` and `/sandbox` are usually one filesystem, and two
  // identical lines are a more honest answer than a hidden mount point.
  const readable = disks.filter((disk): disk is HostDisk => disk !== null);
  if (readable.length > 0) snapshot.disk = readable;

  const empty =
    snapshot.cpu === undefined &&
    snapshot.mem === undefined &&
    snapshot.disk === undefined;
  return empty ? null : snapshot;
}

/** The production probe. Tests build their own deps instead. */
export function createHostProbe(sandboxDir: string): HostProbe {
  return () =>
    readHostSnapshot({
      readText: (path) => readFile(path, "utf8"),
      statfs: async (path) => {
        const stats = await statfs(path);
        return {
          bsize: Number(stats.bsize),
          blocks: Number(stats.blocks),
          bavail: Number(stats.bavail),
        };
      },
      cores: () => availableParallelism(),
      now: () => Date.now(),
      sandboxDir,
    });
}
