import { sandboxEnabled } from "./config";
import { sandboxEndpoint, type SandboxFetch } from "./http";

/**
 * Keep this shape in sync with `container/sandbox/host.ts`. The two bundles do
 * not share code; this side validates what arrives.
 */
export type HostSnapshot = {
  sampledAt: number;
  cpu?: { cores: number; load1?: number };
  mem?: {
    totalBytes?: number;
    availableBytes?: number;
    cgroup?: { limitBytes: number; usedBytes: number };
  };
  disk?: { path: string; totalBytes: number; freeBytes: number }[];
};

export type HostRead =
  | { status: "absent" }
  | { status: "unsupported" }
  | { status: "unavailable"; reason: string }
  | { status: "ok"; snapshot: HostSnapshot };

const TIMEOUT_MS = 2_000;
const OK_TTL_MS = 60_000;
const FAIL_TTL_MS = 30_000;

type Entry = { at: number; value: HostRead };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<HostRead>>();

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function disk(
  value: unknown,
): { path: string; totalBytes: number; freeBytes: number } | null {
  if (value === null || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.path !== "string") return null;
  if (!finite(entry.totalBytes) || entry.totalBytes <= 0) return null;
  if (!finite(entry.freeBytes)) return null;
  if (entry.freeBytes < 0 || entry.freeBytes > entry.totalBytes) return null;
  return {
    path: entry.path,
    totalBytes: entry.totalBytes,
    freeBytes: entry.freeBytes,
  };
}

/** A wrong shape is a failure, not a guess: a fabricated zero reads as "full". */
export function parseHostSnapshot(body: unknown): HostSnapshot | null {
  if (body === null || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (!finite(raw.sampledAt)) return null;

  const snapshot: HostSnapshot = { sampledAt: raw.sampledAt };

  if (raw.cpu !== null && typeof raw.cpu === "object") {
    const cpu = raw.cpu as Record<string, unknown>;
    if (finite(cpu.cores) && cpu.cores >= 1) {
      snapshot.cpu = finite(cpu.load1)
        ? { cores: cpu.cores, load1: cpu.load1 }
        : { cores: cpu.cores };
    }
  }

  if (raw.mem !== null && typeof raw.mem === "object") {
    const mem = raw.mem as Record<string, unknown>;
    // A zero total would divide by zero in the tool's percentage line.
    const totalBytes =
      finite(mem.totalBytes) && mem.totalBytes > 0 ? mem.totalBytes : undefined;
    const availableBytes = finite(mem.availableBytes)
      ? mem.availableBytes
      : undefined;
    const cgroup =
      mem.cgroup !== null && typeof mem.cgroup === "object"
        ? (mem.cgroup as Record<string, unknown>)
        : null;
    const parsedCgroup =
      cgroup !== null &&
      finite(cgroup.limitBytes) &&
      finite(cgroup.usedBytes) &&
      cgroup.limitBytes > 0
        ? { limitBytes: cgroup.limitBytes, usedBytes: cgroup.usedBytes }
        : undefined;
    if (
      totalBytes !== undefined ||
      availableBytes !== undefined ||
      parsedCgroup !== undefined
    ) {
      snapshot.mem = {
        ...(totalBytes === undefined ? {} : { totalBytes }),
        ...(availableBytes === undefined ? {} : { availableBytes }),
        ...(parsedCgroup === undefined ? {} : { cgroup: parsedCgroup }),
      };
    }
  }

  if (Array.isArray(raw.disk)) {
    const disks = raw.disk.map(disk).filter((entry) => entry !== null);
    if (disks.length > 0) snapshot.disk = disks;
  }

  return snapshot;
}

/** The fetch's own signal is not enough: a binding that ignores it would hang. */
function deadline(): { promise: Promise<HostRead>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<HostRead>((resolve) => {
    timer = setTimeout(() => {
      resolve({ status: "unavailable", reason: "timeout" });
    }, TIMEOUT_MS);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

async function load(
  endpoint: { url: string; token: string },
  fetchImpl: SandboxFetch,
): Promise<HostRead> {
  let response: Response;
  try {
    response = await fetchImpl(`${endpoint.url}/host`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { status: "unavailable", reason: "unreachable" };
  }
  // A missing route is the capability check, so 404 is not a failure.
  if (response.status === 404) return { status: "unsupported" };
  if (!response.ok) {
    return { status: "unavailable", reason: `status ${String(response.status)}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable", reason: "bad json" };
  }
  const snapshot = parseHostSnapshot(body);
  return snapshot === null
    ? { status: "unavailable", reason: "bad shape" }
    : { status: "ok", snapshot };
}

/**
 * The host the deployment runs on, or why it cannot be read. Never throws and
 * never blocks a turn longer than TIMEOUT_MS: the prompt assembles this every
 * round, so a broken sandbox must cost one failed request per FAIL_TTL_MS, not
 * one per turn.
 */
export async function readHost(
  env: Env,
  fetchImpl: SandboxFetch = fetch,
  now: () => number = Date.now,
): Promise<HostRead> {
  const endpoint = sandboxEndpoint(env);
  if (endpoint === null) return { status: "absent" };
  if (!sandboxEnabled(env)) return { status: "absent" };

  const key = `${endpoint.url}\u0000${endpoint.token}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    const ttl = cached.value.status === "ok" ? OK_TTL_MS : FAIL_TTL_MS;
    if (now() - cached.at < ttl) return cached.value;
  }

  const pending = inflight.get(key);
  if (pending !== undefined) return pending;

  const limit = deadline();
  const run = Promise.race([load(endpoint, fetchImpl), limit.promise])
    .then((value) => {
      cache.set(key, { at: now(), value });
      if (value.status === "unavailable") {
        console.warn(`sandbox host metrics unavailable: ${value.reason}`);
      }
      return value;
    })
    .finally(() => {
      limit.cancel();
      inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
}
