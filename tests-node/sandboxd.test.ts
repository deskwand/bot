import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseDiskLimitMb,
  startSandboxd,
  type Sandboxd,
} from "../container/sandbox/server";

const TOKEN = "test-token";
const ONE_GIB = 1024 * 1024 * 1024;

let dir = "";
let daemon: Sandboxd | null = null;
let base = "";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "deskwand-sandboxd-"));
  daemon = await startSandboxd(
    {
      token: TOKEN,
      sandboxDir: dir,
      version: "test",
      diskLimitBytes: ONE_GIB,
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 60_000,
    },
    0,
  );
  base = `http://127.0.0.1:${daemon.port}`;
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  return fetch(base + path, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

type ExecBody = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  timedOut: boolean;
  pid: number | null;
  disk: { usedBytes: number; limitBytes: number };
};

async function exec(body: unknown): Promise<ExecBody> {
  const response = await call("/exec", { body });
  expect(response.status).toBe(200);
  return (await response.json()) as ExecBody;
}

describe("sandboxd exec", () => {
  it("returns stdout and the exit code", async () => {
    const result = await exec({ command: "printf hi; exit 3" });
    expect(result.stdout).toBe("hi");
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it("runs commands with /sandbox as the default working directory", async () => {
    const result = await exec({ command: "pwd" });
    // macOS resolves the /var → /private/var symlink for the child's cwd.
    expect(result.stdout.trim()).toBe(realpathSync(dir));
  });

  it("reports usage of the sandbox volume", async () => {
    writeFileSync(join(dir, "payload.bin"), Buffer.alloc(8192));
    const result = await exec({ command: "true" });
    expect(result.disk.limitBytes).toBe(ONE_GIB);
    expect(result.disk.usedBytes).toBeGreaterThanOrEqual(8192);
  });

  it("does not expose SANDBOX_TOKEN to the command", async () => {
    process.env.SANDBOX_TOKEN = TOKEN;
    try {
      const result = await exec({ command: "env" });
      expect(result.stdout).not.toContain(TOKEN);
    } finally {
      delete process.env.SANDBOX_TOKEN;
    }
  });

  it("runs concurrent commands without mixing their output", async () => {
    const started = Date.now();
    const results = await Promise.all([
      exec({ command: "sleep 0.3; echo one" }),
      exec({ command: "sleep 0.3; echo two" }),
      exec({ command: "sleep 0.3; echo three" }),
    ]);
    expect(results.map((r) => r.stdout.trim())).toEqual(["one", "two", "three"]);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("returns early on timeout and leaves the process running", async () => {
    const result = await exec({ command: "sleep 3", timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(typeof result.pid).toBe("number");
    expect(() => process.kill(result.pid!, 0)).not.toThrow();
    process.kill(result.pid!, "SIGKILL");
  });

  it("never buffers more than the default cap, whatever the caller asks", async () => {
    const result = await exec({
      command: "for i in $(seq 1 20000); do echo 0123456789; done",
      stdoutLimit: 1_000_000_000,
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("truncates output past the requested limit", async () => {
    const result = await exec({
      command: "printf abcdefghij",
      stdoutLimit: 5,
    });
    expect(result.stdout).toBe("abcde");
    expect(result.stdoutTruncated).toBe(true);
  });

  it("rejects a missing or wrong token", async () => {
    expect((await call("/exec", { body: { command: "true" }, token: null })).status).toBe(401);
    expect((await call("/exec", { body: { command: "true" }, token: "nope" })).status).toBe(401);
  });

  it("answers healthz with the protocol version", async () => {
    const response = await call("/healthz", { method: "GET" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; protocol: number };
    expect(body.ok).toBe(true);
    expect(body.protocol).toBe(1);
  });
});

describe("sandboxd config", () => {
  it("falls back to 10 GiB when SANDBOX_DISK_MB is absent or malformed", () => {
    expect(parseDiskLimitMb(undefined)).toBe(10240 * 1024 * 1024);
    expect(parseDiskLimitMb("nonsense")).toBe(10240 * 1024 * 1024);
    expect(parseDiskLimitMb("0")).toBe(10240 * 1024 * 1024);
    expect(parseDiskLimitMb("-5")).toBe(10240 * 1024 * 1024);
    expect(parseDiskLimitMb("512")).toBe(512 * 1024 * 1024);
  });
});

describe("sandboxd files", () => {
  it("round-trips a binary file byte for byte", async () => {
    const bytes = Buffer.from([0, 1, 2, 254, 255, 0x89, 0x50, 0x4e, 0x47]);

    const written = await fetch(`${base}/files?path=/tmp/binary.bin`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: bytes,
    });
    expect(written.status).toBe(200);

    const read = await fetch(`${base}/files?path=/tmp/binary.bin`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer())).toEqual(bytes);
  });

  it("rejects a relative path", async () => {
    const response = await fetch(`${base}/files?path=relative.txt`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("BAD_PATH");
  });

  it("reports a missing file as NOT_FOUND", async () => {
    const response = await fetch(`${base}/files?path=/tmp/nope.txt`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("NOT_FOUND");
  });

  it("refuses a write that would pass the disk limit", async () => {
    // `du -sb` counts a directory's own apparent size too, so the limit is set
    // well above the empty-directory overhead and the payloads are what fill it.
    const tightDir = mkdtempSync(join(tmpdir(), "deskwand-sandboxd-tight-"));
    const tight = await startSandboxd(
      {
        token: TOKEN,
        sandboxDir: tightDir,
        version: "test",
        diskLimitBytes: 1024 * 1024,
        defaultTimeoutMs: 5_000,
        maxTimeoutMs: 60_000,
      },
      0,
    );
    try {
      const tightBase = `http://127.0.0.1:${tight.port}`;
      const put = (path: string) =>
        fetch(`${tightBase}/files?path=${encodeURIComponent(path)}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${TOKEN}` },
          body: Buffer.alloc(900 * 1024),
        });
      expect((await put(join(tightDir, "a.bin"))).status).toBe(200);
      const second = await put(join(tightDir, "b.bin"));
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe("DISK_FULL");
    } finally {
      await tight.close();
      rmSync(tightDir, { recursive: true, force: true });
    }
  });

  it("refuses to read something that is not a regular file", async () => {
    const fifo = join(dir, "pipe");
    const made = spawnSync("mkfifo", [fifo]);
    if (made.status !== 0) {
      // Platforms without mkfifo skip this case rather than failing the suite.
      return;
    }
    const response = await fetch(
      `${base}/files?path=${encodeURIComponent(fifo)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("BAD_PATH");
  });

  it("refuses a read above maxBytes", async () => {
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(4096));
    const response = await fetch(
      `${base}/files?path=${encodeURIComponent(join(dir, "big.bin"))}&maxBytes=1024`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe("TOO_LARGE");
  });
});
