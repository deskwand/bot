import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../src/config";
import type { McpAuthDO } from "../../src/mcp/mcp-auth-do";
import type { OAuthDeps } from "../../src/mcp/oauth";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

const URL_A = "https://mcp.test/mcp";
const URL_B = "https://other.test/mcp";

/** Mutates the env seen by Durable Objects created after this call. */
function setEnv(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!savedEnv.has(key)) savedEnv.set(key, ENV[key]);
    ENV[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete ENV[key];
    else ENV[key] = value;
  }
  savedEnv.clear();
}

function configFor(servers: McpServerConfig[]): unknown {
  return {
    schemaVersion: 1,
    owner: { telegramUserIds: [100000001] },
    models: {
      butler: { provider: "deepseek", id: "deepseek-flash" },
      task: { provider: "deepseek", id: "deepseek-flash" },
    },
    mcpServers: servers,
  };
}

const NOTION: McpServerConfig = {
  name: "notion",
  url: URL_A,
  oauth: true,
};

type TokenBody = {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
};

/** In-memory authorization server the OAuth helpers talk to. */
class FakeOAuthServer {
  readonly calls = { register: 0, exchange: 0, refresh: 0 };

  invalidGrant = false;

  expiresIn = 3600;

  private tokens = 0;

  readonly fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return new Response("not found", { status: 404 });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://mcp.test/",
        authorization_endpoint: "https://mcp.test/authorize",
        token_endpoint: "https://mcp.test/token",
        registration_endpoint: "https://mcp.test/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
    }
    if (url.pathname === "/register" && init?.method === "POST") {
      this.calls.register += 1;
      return Response.json({
        client_id: "client-1",
        redirect_uris: ["https://example.com/mcp/oauth/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      });
    }
    if (url.pathname === "/token" && init?.method === "POST") {
      const body = new URLSearchParams(String(init.body ?? ""));
      if (body.get("grant_type") === "refresh_token") {
        this.calls.refresh += 1;
        if (this.invalidGrant) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json(this.tokenBody());
      }
      this.calls.exchange += 1;
      return Response.json(this.tokenBody());
    }
    return new Response("not found", { status: 404 });
  };

  private tokenBody(): TokenBody {
    this.tokens += 1;
    return {
      access_token: `at-${this.tokens}`,
      token_type: "Bearer",
      refresh_token: "rt-1",
      expires_in: this.expiresIn,
    };
  }
}

type Harness = {
  fake: FakeOAuthServer;
  clock: { now: number };
  deps: OAuthDeps;
  nextState: () => number;
};

function harness(): Harness {
  const fake = new FakeOAuthServer();
  const clock = { now: 1_000_000 };
  let state = 0;

  return {
    fake,
    clock,
    deps: {
      fetch: fake.fetch as unknown as typeof fetch,
      randomHex: (bytes) =>
        String((state += 1))
          .padStart(bytes * 2, "0")
          .slice(-bytes * 2),
      now: () => clock.now,
    },
    nextState: () => state,
  };
}

function authStub(name: string) {
  return env.MCP_AUTH.get(env.MCP_AUTH.idFromName(name));
}

function install(instance: McpAuthDO, deps: OAuthDeps): void {
  instance.oauthDeps = () => deps;
}

/** Replaces the DO's config view so URL changes are visible to it. */
function setInstanceConfig(
  instance: McpAuthDO,
  servers: McpServerConfig[],
): void {
  (instance as unknown as { env: Record<string, unknown> }).env = {
    ...(instance as unknown as { env: Record<string, unknown> }).env,
    DESKWAND_CONFIG: configFor(servers),
  };
}

/** Captures Butler notices without touching a real channel. */
async function captureNotices(notices: string[]): Promise<void> {
  const butler = env.BUTLER.get(env.BUTLER.idFromName("owner"));
  await runInDurableObject(butler, (instance) => {
    (
      instance as unknown as {
        sendBestEffort(message: { text: string }): Promise<null>;
      }
    ).sendBestEffort = async (message) => {
      notices.push(message.text);
      return null;
    };
  });
}

beforeEach(() => {
  setEnv({ DESKWAND_CONFIG: configFor([NOTION]) });
});

afterEach(() => {
  restoreEnv();
});

describe("McpAuthDO", () => {
  it("registers once, then authorizes and stores tokens", async () => {
    const { fake, deps } = harness();

    await runInDurableObject(authStub("auth-success"), async (instance) => {
      install(instance, deps);

      const started = await instance.startAuthorization("notion");
      const url = new URL(started.url);
      const state = url.searchParams.get("state");
      expect(state).toBeTruthy();
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(fake.calls.register).toBe(1);

      expect(await instance.completeAuthorization(state!, "code-1")).toBe(true);
      expect(await instance.status()).toEqual([{ name: "notion", state: "ok" }]);

      await instance.startAuthorization("notion");
      expect(fake.calls.register).toBe(1);
    });
  });

  it("rejects an unknown, reused or expired state without touching tokens", async () => {
    const { fake, deps, clock } = harness();

    await runInDurableObject(authStub("auth-replay"), async (instance) => {
      install(instance, deps);

      const first = await instance.startAuthorization("notion");
      const firstState = new URL(first.url).searchParams.get("state")!;
      expect(await instance.completeAuthorization(firstState, "code-1")).toBe(
        true,
      );

      expect(await instance.completeAuthorization(firstState, "code-1")).toBe(
        false,
      );
      expect(await instance.completeAuthorization("missing", "code-1")).toBe(
        false,
      );

      const second = await instance.startAuthorization("notion");
      const secondState = new URL(second.url).searchParams.get("state")!;
      clock.now += 10 * 60 * 1000 + 1;
      expect(await instance.completeAuthorization(secondState, "code-2")).toBe(
        false,
      );

      expect(await instance.accessToken("notion", URL_A)).toBe("at-1");
      expect(fake.calls.exchange).toBe(1);
    });
  });

  it("refreshes when less than 60 seconds remain and merges concurrent refreshes", async () => {
    const { fake, deps } = harness();
    fake.expiresIn = 59;

    await runInDurableObject(authStub("auth-refresh"), async (instance) => {
      install(instance, deps);
      const started = await instance.startAuthorization("notion");
      const state = new URL(started.url).searchParams.get("state")!;
      expect(await instance.completeAuthorization(state, "code-1")).toBe(true);

      const tokens = await Promise.all([
        instance.accessToken("notion", URL_A),
        instance.accessToken("notion", URL_A),
      ]);

      expect(tokens).toEqual(["at-2", "at-2"]);
      expect(fake.calls.refresh).toBe(1);
    });
  });

  it("marks needs_reauth on invalid_grant and notifies exactly once", async () => {
    const { fake, deps } = harness();
    const notices: string[] = [];
    await captureNotices(notices);
    fake.expiresIn = 59;

    await runInDurableObject(authStub("auth-invalid"), async (instance) => {
      install(instance, deps);
      const started = await instance.startAuthorization("notion");
      const state = new URL(started.url).searchParams.get("state")!;
      expect(await instance.completeAuthorization(state, "code-1")).toBe(true);

      fake.invalidGrant = true;
      expect(await instance.accessToken("notion", URL_A)).toBeNull();
      expect(await instance.accessToken("notion", URL_A)).toBeNull();
      expect(notices).toEqual([
        "🔑 notion 授权已失效，请在桌面端重新登录",
      ]);
      expect(await instance.status()).toEqual([
        { name: "notion", state: "needs_reauth" },
      ]);

      // A successful re-authorization clears the notice flag, so a later
      // failure notifies again.
      fake.invalidGrant = false;
      const again = await instance.startAuthorization("notion");
      const againState = new URL(again.url).searchParams.get("state")!;
      expect(await instance.completeAuthorization(againState, "code-2")).toBe(
        true,
      );
      fake.invalidGrant = true;
      expect(await instance.accessToken("notion", URL_A)).toBeNull();
    });

    expect(notices).toHaveLength(2);
  });

  it("treats a changed URL as unauthorized", async () => {
    const { deps } = harness();

    await runInDurableObject(authStub("auth-url"), async (instance) => {
      install(instance, deps);
      const started = await instance.startAuthorization("notion");
      const state = new URL(started.url).searchParams.get("state")!;
      expect(await instance.completeAuthorization(state, "code-1")).toBe(true);

      expect(await instance.accessToken("notion", URL_B)).toBeNull();

      setInstanceConfig(instance, [{ ...NOTION, url: URL_B }]);
      expect(await instance.status()).toEqual([
        { name: "notion", state: "unauthorized" },
      ]);
    });
  });

  it("revoke deletes client and tokens", async () => {
    const { fake, deps } = harness();

    await runInDurableObject(authStub("auth-revoke"), async (instance) => {
      install(instance, deps);
      const started = await instance.startAuthorization("notion");
      const state = new URL(started.url).searchParams.get("state")!;
      expect(await instance.completeAuthorization(state, "code-1")).toBe(true);

      await instance.revoke("notion");
      expect(await instance.status()).toEqual([
        { name: "notion", state: "unauthorized" },
      ]);
      expect(await instance.accessToken("notion", URL_A)).toBeNull();

      await instance.startAuthorization("notion");
      expect(fake.calls.register).toBe(2);
    });
  });

  it("probe reports auth state instead of connecting when not authorized", async () => {
    const { deps } = harness();

    await runInDurableObject(authStub("auth-probe"), async (instance) => {
      install(instance, deps);
      expect(await instance.probe("notion")).toEqual({
        ok: false,
        auth: "unauthorized",
        reason: "需要在桌面端登录授权",
      });
    });
  });
});
