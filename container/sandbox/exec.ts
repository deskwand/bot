import { spawn } from "node:child_process";

/** How a command may run, owned by the caller so tests can use small values. */
export type ExecLimits = {
  sandboxDir: string;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
};

export type ExecRequest = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  stdoutLimit?: number;
  stderrLimit?: number;
};

export type ExecOutcome = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  pid: number | null;
  durationMs: number;
  /** Set when the command could not be started at all (bad cwd, no /bin/sh). */
  error: string | null;
};

const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const MIN_TIMEOUT_MS = 1_000;

/** A caller-supplied cap, never above the default: this is a memory guard. */
function outputLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_OUTPUT_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(requested), 0), DEFAULT_OUTPUT_LIMIT);
}

/**
 * The command sees exactly these variables. Inheriting process.env would hand
 * SANDBOX_TOKEN to anything the model decides to run.
 */
function childEnv(sandboxDir: string): NodeJS.ProcessEnv {
  // Cast because this repository's generated types widen the global ProcessEnv
  // with required Worker bindings; the child must not inherit any of them.
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: sandboxDir,
    LANG: "C.UTF-8",
    TERM: "dumb",
  } as unknown as NodeJS.ProcessEnv;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Collects one stream, keeping only the first `limit` bytes. */
function collector(limit: number) {
  const chunks: Buffer[] = [];
  let kept = 0;
  let truncated = false;
  return {
    push(chunk: Buffer): void {
      if (kept >= limit) {
        truncated = true;
        return;
      }
      const room = limit - kept;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        kept = limit;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      kept += chunk.length;
    },
    text(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
    get isTruncated(): boolean {
      return truncated;
    },
  };
}

export function runCommand(
  request: ExecRequest,
  limits: ExecLimits,
): Promise<ExecOutcome> {
  const started = Date.now();
  const timeoutMs = clamp(
    request.timeoutMs ?? limits.defaultTimeoutMs,
    MIN_TIMEOUT_MS,
    limits.maxTimeoutMs,
  );
  const stdout = collector(outputLimit(request.stdoutLimit));
  const stderr = collector(outputLimit(request.stderrLimit));

  return new Promise<ExecOutcome>((resolve) => {
    const child = spawn("/bin/sh", ["-c", request.command], {
      cwd: request.cwd ?? limits.sandboxDir,
      env: childEnv(limits.sandboxDir),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"] as const,
    });

    let settled = false;
    const finish = (
      timedOut: boolean,
      exitCode: number | null,
      error: string | null = null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.isTruncated,
        stderrTruncated: stderr.isTruncated,
        timedOut,
        pid: child.pid ?? null,
        durationMs: Date.now() - started,
        error,
      });
    };

    const timer = setTimeout(() => {
      // Not killed: the caller gets the pid and can follow up with ps/kill.
      // Its output is gone though — anyone writing to the closed pipes gets
      // EPIPE, which is why the prompt asks for explicit redirection.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish(true, null);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    // Node reports a missing cwd as a spawn ENOENT on the binary, so name the
    // directory to keep the message useful.
    child.on("error", (error: Error) =>
      finish(false, null, `cannot start in ${request.cwd ?? limits.sandboxDir}: ${error.message}`),
    );
    child.on("close", (code) => finish(false, code));
  });
}
