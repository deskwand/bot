export type DiskUsage = { usedBytes: number; limitBytes: number };

export type SandboxErrorCode =
  | "UNAVAILABLE"
  | "UNAUTHORIZED"
  | "TOO_LARGE"
  | "DISK_FULL"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "PROTOCOL";

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export type SandboxExecResult = {
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
  disk: DiskUsage;
};

export type SandboxRunOptions = {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type SandboxHealth = {
  ok: boolean;
  protocol?: number;
  detail?: string;
  disk?: DiskUsage;
};

export interface SandboxProvider {
  readonly kind: "http" | "cloudflare";
  health(): Promise<SandboxHealth>;
  run(command: string, options?: SandboxRunOptions): Promise<SandboxExecResult>;
  readFile(path: string, maxBytes: number): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}
