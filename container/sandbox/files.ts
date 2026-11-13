import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export type SandboxFileCode =
  | "BAD_PATH"
  | "NOT_FOUND"
  | "TOO_LARGE"
  | "DISK_FULL";

export class SandboxFileError extends Error {
  constructor(
    readonly code: SandboxFileCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxFileError";
  }
}

/** Any absolute path is allowed; the container is the boundary, not the path. */
export function sandboxPath(raw: string): string {
  if (raw === "" || !isAbsolute(raw) || raw.includes("\0")) {
    throw new SandboxFileError("BAD_PATH", "path must be absolute");
  }
  return raw;
}

export async function readSandboxFile(
  raw: string,
  maxBytes: number,
): Promise<Buffer> {
  const path = sandboxPath(raw);
  let size: number;
  try {
    const info = await stat(path);
    // A FIFO or a device would block this read forever.
    if (!info.isFile()) {
      throw new SandboxFileError("BAD_PATH", `not a regular file: ${path}`);
    }
    size = info.size;
  } catch (error) {
    if (error instanceof SandboxFileError) throw error;
    throw new SandboxFileError("NOT_FOUND", `no such file: ${path}`);
  }
  if (size > maxBytes) {
    throw new SandboxFileError(
      "TOO_LARGE",
      `file is ${String(size)} bytes, limit is ${String(maxBytes)}`,
    );
  }
  try {
    return await readFile(path);
  } catch {
    throw new SandboxFileError("NOT_FOUND", `no such file: ${path}`);
  }
}

export async function writeSandboxFile(
  raw: string,
  data: Buffer,
  limits: { diskLimitBytes: number; usedBytes: number },
): Promise<number> {
  const path = sandboxPath(raw);
  if (limits.usedBytes + data.length > limits.diskLimitBytes) {
    throw new SandboxFileError(
      "DISK_FULL",
      `writing ${String(data.length)} bytes would pass the ${String(limits.diskLimitBytes)} byte limit`,
    );
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return data.length;
}
