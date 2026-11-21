import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import { modelCredentialKey } from "../../src/llm/credential-key";
import { QUOTA_TTL_MS, setQuotaFetch } from "../../src/llm/quota";
import { QUOTA_CACHE_KEY } from "../../src/llm/quota-key";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const CODEX = "openai-codex";
const NOW = Date.UTC(2030, 0, 1, 0, 0, 0);

let now = NOW;

function life(name: string) {
  return env.LIFE.get(env.LIFE.idFromName(name));
}

function codexBody(usedPercent: number) {
  return {
    plan_type: "team",
    rate_limit: {
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 18000,
        reset_at: NOW / 1000 + 3600,
      },
      secondary_window: null,
    },
  };
}

/** Seeds an unexpired credential; the cache is always cleared. */
async function seed(name: string, expires = NOW + 3_600_000): Promise<void> {
  await runInDurableObject(life(name), async (_instance, state) => {
    await state.storage.delete(QUOTA_CACHE_KEY);
    await state.storage.kv.put(modelCredentialKey(CODEX), {
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires,
    });
  });
}

async function credential(name: string) {
  return await runInDurableObject(life(name), async (_instance, state) => {
    return await state.storage.kv.get(modelCredentialKey(CODEX));
  });
}

beforeEach(() => {
  now = NOW;
  setClockOverride({
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  setClockOverride(null);
  setQuotaFetch(null);
});

describe("LifeDO.quota", () => {
  it("never blocks the first read and caches the result", async () => {
    await seed("quota-first");
    let calls = 0;
    setQuotaFetch(async () => {
      calls += 1;
      return Response.json(codexBody(9));
    });

    const stub = life("quota-first");
    const first = await stub.quota([CODEX]);
    expect(first).toEqual({ providers: [], failures: [] });

    // The refresh runs in waitUntil; wait on the cache, not on the call count.
    await vi.waitFor(async () => {
      expect((await stub.quota([CODEX])).providers).toHaveLength(1);
    });
    expect(calls).toBe(1);
  });

  it("returns the cached value first and refreshes once it is stale", async () => {
    await seed("quota-stale");
    let used = 9;
    let calls = 0;
    setQuotaFetch(async () => {
      calls += 1;
      return Response.json(codexBody(used));
    });

    const stub = life("quota-stale");
    await vi.waitFor(async () => {
      expect((await stub.quota([CODEX])).providers).toHaveLength(1);
    });

    now = NOW + QUOTA_TTL_MS;
    used = 40;
    const stale = await stub.quota([CODEX]);
    expect(stale.providers[0]?.windows[0]?.usedPercent).toBe(9);

    await vi.waitFor(
      async () => {
        expect(
          (await stub.quota([CODEX])).providers[0]?.windows[0]?.usedPercent,
        ).toBe(40);
      },
      { timeout: 3_000 },
    );
    expect(calls).toBe(2);
  });

  it("coalesces concurrent refreshes into one request", async () => {
    await seed("quota-single-flight");
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setQuotaFetch(async () => {
      calls += 1;
      await gate;
      return Response.json(codexBody(9));
    });

    const stub = life("quota-single-flight");
    const first = stub.quota([CODEX]);
    const second = stub.quota([CODEX]);
    release();
    await Promise.all([first, second]);

    await vi.waitFor(() => expect(calls).toBe(1));
  });

  it("keeps the last good value and records the failure", async () => {
    await seed("quota-failure");
    let calls = 0;
    setQuotaFetch(async () => {
      calls += 1;
      return calls === 1
        ? Response.json(codexBody(9))
        : new Response("", { status: 500 });
    });

    const stub = life("quota-failure");
    await vi.waitFor(async () => {
      expect((await stub.quota([CODEX])).providers).toHaveLength(1);
    });

    now = NOW + QUOTA_TTL_MS;
    await vi.waitFor(
      async () => {
        expect((await stub.quota([CODEX])).failures).toHaveLength(1);
      },
      { timeout: 3_000 },
    );

    const after = await stub.quota([CODEX]);
    expect(after.providers[0]?.windows[0]?.usedPercent).toBe(9);
    expect(after.failures).toEqual([
      { provider: CODEX, reason: "unreachable", at: now },
    ]);
  });

  it("does not retry a failed provider on every turn", async () => {
    await seed("quota-no-retry");
    let calls = 0;
    setQuotaFetch(async () => {
      calls += 1;
      return new Response("", { status: 500 });
    });

    const stub = life("quota-no-retry");
    await vi.waitFor(async () => {
      expect((await stub.quota([CODEX])).failures).toHaveLength(1);
    });
    expect(calls).toBe(1);

    await stub.quota([CODEX]);
    await stub.quota([CODEX]);
    expect(calls).toBe(1);
  });

  it("does not retry a failing provider that still has an older good value", async () => {
    await seed("quota-fail-stale");
    let calls = 0;
    setQuotaFetch(async () => {
      calls += 1;
      return calls === 1
        ? Response.json(codexBody(9))
        : new Response("", { status: 500 });
    });

    const stub = life("quota-fail-stale");
    await vi.waitFor(async () => {
      expect((await stub.quota([CODEX])).providers).toHaveLength(1);
    });

    now = NOW + QUOTA_TTL_MS;
    await vi.waitFor(
      async () => {
        expect((await stub.quota([CODEX])).failures).toHaveLength(1);
      },
      { timeout: 3_000 },
    );
    const failedAt = (await stub.quota([CODEX])).failures[0]?.at;
    expect(calls).toBe(2);

    // The failure is the newest attempt: three turns later there must still be
    // exactly two requests, and the recorded failure must not move.
    await stub.quota([CODEX]);
    await stub.quota([CODEX]);
    await stub.quota([CODEX]);

    expect(calls).toBe(2);
    expect((await stub.quota([CODEX])).failures[0]?.at).toBe(failedAt);
  });

  it("does not delete the credential when the endpoint rejects it", async () => {
    await seed("quota-rejected");
    let calls = 0;
    setQuotaFetch(async () => {
      calls += 1;
      return new Response("", { status: 401 });
    });

    const stub = life("quota-rejected");
    await vi.waitFor(async () => {
      expect((await stub.quota([CODEX])).failures[0]?.reason).toBe("rejected");
    });

    expect(calls).toBe(1);
    expect(await credential("quota-rejected")).toEqual({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: NOW + 3_600_000,
    });
  });

  it("reports signed_out when there is no credential", async () => {
    await runInDurableObject(life("quota-signed-out"), async (_instance, state) => {
      await state.storage.delete(QUOTA_CACHE_KEY);
      await state.storage.kv.delete(modelCredentialKey(CODEX));
    });
    let calls = 0;
    setQuotaFetch(async () => {
      calls += 1;
      return Response.json(codexBody(9));
    });

    const stub = life("quota-signed-out");
    await vi.waitFor(async () => {
      expect((await stub.quota([CODEX])).failures[0]?.reason).toBe("signed_out");
    });

    expect(calls).toBe(0);
  });

  it("never refreshes or drops an expired credential", async () => {
    await seed("quota-expired", NOW - 1_000);
    let calls = 0;
    setQuotaFetch(async () => {
      calls += 1;
      return Response.json(codexBody(9));
    });

    const stub = life("quota-expired");
    await stub.quota([CODEX]);
    // The refresh runs in waitUntil; give it room to have happened if it could.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toBe(0);
    const snapshot = await stub.quota([CODEX]);
    expect(snapshot.failures[0]?.reason).toBe("rejected");
    expect(await credential("quota-expired")).toEqual({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: NOW - 1_000,
    });
  });

  it("makes no request when nothing is in use", async () => {
    await seed("quota-empty");
    let calls = 0;
    setQuotaFetch(async () => {
      calls += 1;
      return Response.json(codexBody(9));
    });

    const snapshot = await life("quota-empty").quota([]);

    expect(snapshot).toEqual({ providers: [], failures: [] });
    expect(calls).toBe(0);
  });
});
