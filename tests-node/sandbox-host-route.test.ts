import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostProbe } from "../container/sandbox/host";
import { startSandboxd, type Sandboxd } from "../container/sandbox/server";

const TOKEN = "host-token";

let dir = "";
let served: Sandboxd | null = null;
let base = "";

async function start(host: HostProbe): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "deskwand-host-"));
  served = await startSandboxd(
    {
      token: TOKEN,
      sandboxDir: dir,
      version: "test",
      diskLimitBytes: 1024 * 1024 * 1024,
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 60_000,
      host,
    },
    0,
  );
  base = `http://127.0.0.1:${String(served.port)}`;
}

afterEach(async () => {
  await served?.close();
  served = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /host", () => {
  it("serves the snapshot to an authorized caller", async () => {
    await start(async () => ({ sampledAt: 5, cpu: { cores: 2, load1: 0.5 } }));

    const response = await fetch(`${base}/host`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sampledAt: 5,
      cpu: { cores: 2, load1: 0.5 },
    });
  });

  it("refuses a caller without the token", async () => {
    await start(async () => ({ sampledAt: 5 }));

    const response = await fetch(`${base}/host`);

    expect(response.status).toBe(401);
  });

  it("answers 503 when the probe has nothing", async () => {
    await start(async () => null);

    const response = await fetch(`${base}/host`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "HOST_UNAVAILABLE" });
  });
});
