import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { McpAuthStore } from "../../src/mcp/auth-store";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

let nextId = 0;

/** Runs a body against a store backed by a fresh DO's SQLite storage. */
function withStore<T>(body: (store: McpAuthStore) => T): Promise<T> {
  nextId += 1;
  const stub = env.BUTLER.get(env.BUTLER.idFromName(`auth-store-${nextId}`));
  return runInDurableObject(stub, (_instance, state) =>
    body(new McpAuthStore(state.storage.sql)),
  );
}

describe("McpAuthStore", () => {
  it("keeps a client only while the configured URL matches", async () => {
    const found = await withStore((store) => {
      store.saveClient("notion", "https://a.test/mcp", {
        issuer: "https://a.test",
        clientId: "client-1",
        clientSecret: "secret-1",
      }, 1000);

      return {
        same: store.getClient("notion", "https://a.test/mcp"),
        other: store.getClient("notion", "https://b.test/mcp"),
      };
    });

    expect(found.same).toEqual({
      name: "notion",
      url: "https://a.test/mcp",
      issuer: "https://a.test",
      clientId: "client-1",
      clientSecret: "secret-1",
      registeredAt: 1000,
    });
    expect(found.other).toBeNull();
  });

  it("stores tokens and resets the notice flag on re-authorization", async () => {
    const states = await withStore((store) => {
      store.saveTokens("notion", "https://a.test/mcp", {
        accessToken: "at-1",
        refreshToken: "rt-1",
        expiresAt: 5000,
        scope: "read",
      });
      const saved = store.getTokens("notion", "https://a.test/mcp");

      store.markNeedsReauth("notion");
      const marked = store.getTokens("notion", "https://a.test/mcp");
      const firstNotice = store.takeNotice("notion");
      const secondNotice = store.takeNotice("notion");

      store.saveTokens("notion", "https://a.test/mcp", {
        accessToken: "at-2",
        refreshToken: "rt-2",
        expiresAt: 9000,
        scope: undefined,
      });
      const reauthorized = store.getTokens("notion", "https://a.test/mcp");
      const noticeAfterReauth = store.takeNotice("notion");

      return {
        saved,
        marked,
        firstNotice,
        secondNotice,
        reauthorized,
        noticeAfterReauth,
      };
    });

    expect(states.saved).toMatchObject({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 5000,
      scope: "read",
      state: "ok",
      notified: false,
    });
    expect(states.marked).toMatchObject({ state: "needs_reauth" });
    expect(states.firstNotice).toBe(true);
    expect(states.secondNotice).toBe(false);
    expect(states.reauthorized).toMatchObject({
      accessToken: "at-2",
      state: "ok",
      notified: false,
    });
    expect(states.noticeAfterReauth).toBe(true);
  });

  it("takes a pending authorization exactly once", async () => {
    const result = await withStore((store) => {
      store.putPending("state-1", "notion", "verifier-1", 1000);
      return {
        first: store.takePending("state-1", 2000),
        second: store.takePending("state-1", 2000),
      };
    });

    expect(result.first).toEqual({
      state: "state-1",
      name: "notion",
      verifier: "verifier-1",
      createdAt: 1000,
    });
    expect(result.second).toBeNull();
  });

  it("expires a pending authorization after ten minutes", async () => {
    const result = await withStore((store) => {
      store.putPending("state-2", "notion", "verifier-2", 1000);
      return {
        late: store.takePending("state-2", 1000 + 10 * 60 * 1000),
        after: store.takePending("state-2", 2000),
      };
    });

    expect(result.late).toBeNull();
    expect(result.after).toBeNull();
  });

  it("purges abandoned authorizations when a new one starts", async () => {
    nextId += 1;
    const stub = env.BUTLER.get(env.BUTLER.idFromName(`auth-store-${nextId}`));
    const states = await runInDurableObject(stub, (_instance, state) => {
      const store = new McpAuthStore(state.storage.sql);
      store.putPending("old", "notion", "v-old", 1000);
      store.putPending("new", "notion", "v-new", 1000 + 10 * 60 * 1000);
      return state.storage.sql
        .exec<{ state: string }>(`SELECT state FROM pending ORDER BY state`)
        .toArray()
        .map((row) => row.state);
    });
    expect(states).toEqual(["new"]);
  });
});
