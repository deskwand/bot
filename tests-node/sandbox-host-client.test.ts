import { describe, expect, it, vi } from "vitest";
import type { SandboxFetch } from "../src/sandbox/http";
import { readHost } from "../src/sandbox/host";

// The cache is module-level and keyed by endpoint, so every test gets its own
// endpoint: sharing one would let an earlier result satisfy a later call.
let sequence = 0;
function sandbox(config?: unknown): { env: Env; url: string; token: string } {
  sequence += 1;
  const url = `http://sandbox-${String(sequence)}:8080`;
  const token = `token-${String(sequence)}`;
  const env = {
    SANDBOX_URL: url,
    SANDBOX_TOKEN: token,
    ...(config === undefined ? {} : { DESKWAND_CONFIG: config }),
  } as unknown as Env;
  return { env, url, token };
}

const SNAPSHOT = {
  sampledAt: 1_763_000_000_000,
  cpu: { cores: 4, load1: 0.5 },
  disk: [{ path: "/", totalBytes: 1000, freeBytes: 400 }],
};

/** A config document the runtime schema accepts, for the enabled=false case. */
const CONFIG = {
  schemaVersion: 1,
  owner: { telegramUserIds: [1] },
  models: {
    butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  },
  mcpServers: [],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readHost", () => {
  it("never calls the sandbox when the deployment has none", async () => {
    const fetchImpl = vi.fn(async () => json(SNAPSHOT));

    await expect(
      readHost({} as unknown as Env, fetchImpl as unknown as SandboxFetch),
    ).resolves.toEqual({ status: "absent" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never calls the sandbox when the config disables it", async () => {
    const fetchImpl = vi.fn(async () => json(SNAPSHOT));
    const { env } = sandbox({ ...CONFIG, sandbox: { enabled: false } });

    await expect(
      readHost(env, fetchImpl as unknown as SandboxFetch),
    ).resolves.toEqual({ status: "absent" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the snapshot with the bearer token", async () => {
    const { env, url, token } = sandbox();
    const fetchImpl = vi.fn(async () => json(SNAPSHOT));

    const read = await readHost(env, fetchImpl as unknown as SandboxFetch);

    expect(read).toEqual({ status: "ok", snapshot: SNAPSHOT });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${url}/host`,
      expect.objectContaining({
        headers: { authorization: `Bearer ${token}` },
        // The 2 s ceiling is what keeps a wedged sandbox from stalling a turn.
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("treats a 404 as an old sandbox image", async () => {
    const read = await readHost(
      sandbox().env,
      (async () => json({}, 404)) as unknown as SandboxFetch,
    );

    expect(read).toEqual({ status: "unsupported" });
  });

  it("reports a failure with a reason instead of throwing", async () => {
    const read = await readHost(
      sandbox().env,
      (async () => {
        throw new Error("network down");
      }) as unknown as SandboxFetch,
    );

    expect(read).toEqual({ status: "unavailable", reason: "unreachable" });
  });

  it("drops a disk whose total is zero", async () => {
    const read = await readHost(
      sandbox().env,
      (async () =>
        json({
          sampledAt: 1,
          disk: [
            { path: "/", totalBytes: 0, freeBytes: 0 },
            { path: "/sandbox", totalBytes: 1000, freeBytes: 100 },
          ],
        })) as unknown as SandboxFetch,
    );

    expect(read).toEqual({
      status: "ok",
      snapshot: {
        sampledAt: 1,
        disk: [{ path: "/sandbox", totalBytes: 1000, freeBytes: 100 }],
      },
    });
  });

  it("drops a disk that claims more free space than it has", async () => {
    const read = await readHost(
      sandbox().env,
      (async () =>
        json({
          sampledAt: 1,
          disk: [{ path: "/", totalBytes: 100, freeBytes: 900 }],
        })) as unknown as SandboxFetch,
    );

    expect(read).toEqual({ status: "ok", snapshot: { sampledAt: 1 } });
  });

  it("reports a server error with its status", async () => {
    const read = await readHost(
      sandbox().env,
      (async () => json({}, 500)) as unknown as SandboxFetch,
    );

    expect(read).toEqual({ status: "unavailable", reason: "status 500" });
  });

  it("gives up after two seconds even when fetch never settles", async () => {
    const { env } = sandbox();
    vi.useFakeTimers();
    try {
      const pending = readHost(
        env,
        (() => new Promise<Response>(() => {})) as unknown as SandboxFetch,
      );
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toEqual({
        status: "unavailable",
        reason: "timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a snapshot without sampledAt", async () => {
    const read = await readHost(
      sandbox().env,
      (async () => json({ cpu: { cores: 4 } })) as unknown as SandboxFetch,
    );

    expect(read).toEqual({ status: "unavailable", reason: "bad shape" });
  });

  it("caches a success for 60 seconds", async () => {
    const { env } = sandbox();
    const fetchImpl = vi.fn(async () => json(SNAPSHOT));
    let clock = 1_000;

    await readHost(env, fetchImpl as unknown as SandboxFetch, () => clock);
    clock += 59_000;
    await readHost(env, fetchImpl as unknown as SandboxFetch, () => clock);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock += 2_000;
    await readHost(env, fetchImpl as unknown as SandboxFetch, () => clock);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("caches a failure for 30 seconds", async () => {
    const { env } = sandbox();
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });
    let clock = 5_000;

    await readHost(env, fetchImpl as unknown as SandboxFetch, () => clock);
    clock += 29_000;
    await readHost(env, fetchImpl as unknown as SandboxFetch, () => clock);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock += 2_000;
    await readHost(env, fetchImpl as unknown as SandboxFetch, () => clock);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("merges concurrent readers into one request", async () => {
    const { env } = sandbox();
    const fetchImpl = vi.fn(async () => json(SNAPSHOT));

    const [first, second] = await Promise.all([
      readHost(env, fetchImpl as unknown as SandboxFetch),
      readHost(env, fetchImpl as unknown as SandboxFetch),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });
});
