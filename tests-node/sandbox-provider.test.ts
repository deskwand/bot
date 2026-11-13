import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandboxd, type Sandboxd } from "../container/sandbox/server";
import { httpSandboxProvider } from "../src/sandbox/http";
import { sandboxProviderContract } from "./helpers/sandbox-contract";

const TOKEN = "provider-token";
let dir = "";
let daemon: Sandboxd | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "deskwand-provider-"));
  daemon = await startSandboxd(
    {
      token: TOKEN,
      sandboxDir: dir,
      version: "test",
      diskLimitBytes: 1024 * 1024 * 1024,
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 60_000,
    },
    0,
  );
});

afterAll(async () => {
  await daemon?.close();
  rmSync(dir, { recursive: true, force: true });
});

function provider(overrides: { url?: string; token?: string } = {}) {
  return httpSandboxProvider({
    SANDBOX_URL: overrides.url ?? `http://127.0.0.1:${String(daemon?.port ?? 0)}`,
    SANDBOX_TOKEN: overrides.token ?? TOKEN,
  });
}

describe("httpSandboxProvider", () => {
  it("is absent unless both variables are set", () => {
    expect(httpSandboxProvider({})).toBeNull();
    expect(httpSandboxProvider({ SANDBOX_URL: "http://x" })).toBeNull();
    expect(httpSandboxProvider({ SANDBOX_TOKEN: "t" })).toBeNull();
    expect(httpSandboxProvider({ SANDBOX_URL: "  ", SANDBOX_TOKEN: "t" })).toBeNull();
  });

  it("maps a wrong token to UNAUTHORIZED without echoing it", async () => {
    const client = provider({ token: "wrong-token-value" });
    expect(client).not.toBeNull();
    const error = (await client!.run("true").catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ name: "SandboxError", code: "UNAUTHORIZED" });
    expect(error.message).not.toContain("wrong-token-value");
  });

  it("maps an unreachable host to an unhealthy report", async () => {
    const client = provider({ url: "http://127.0.0.1:1" });
    expect(client).not.toBeNull();
    await expect(client!.health()).resolves.toMatchObject({ ok: false });
  });

  sandboxProviderContract("http", () => provider()!);
});
