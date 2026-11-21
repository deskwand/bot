import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexAccessToken,
  codexStatus,
  completeCodexBrowserLogin,
  disconnectCodex,
  pollCodexLogin,
  startCodexBrowserLogin,
  startCodexLogin,
} from "../../src/llm/codex";
import { readModelCredential, saveModelCredential } from "../../src/llm/model-auth";
import { createModelsForEnv } from "../../src/llm/models";
import { fakeCodexToken } from "../helpers/codex-token";

const CODEX = "openai-codex";
const AUTH = "https://auth.openai.com";

const device = { deviceAuthId: "device-1", userCode: "ABCD-1234" };

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** The three Codex auth endpoints, with per-test overrides. */
class FakeCodexServer {
  readonly paths: string[] = [];

  tokenCalls = 0;

  userCode: Route = () =>
    Response.json({ device_auth_id: "device-1", user_code: "ABCD-1234", interval: "5" });

  poll: Route = () => new Response("", { status: 403 });

  token: Route = () =>
    Response.json({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
    });

  readonly fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.href.startsWith(AUTH)) this.paths.push(url.pathname);
    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      return this.userCode(url, init);
    }
    if (url.pathname === "/api/accounts/deviceauth/token") return this.poll(url, init);
    if (url.pathname === "/oauth/token") {
      this.tokenCalls += 1;
      return this.token(url, init);
    }
    return new Response("not found", { status: 404 });
  };
}

function harness() {
  const server = new FakeCodexServer();
  return { server, fetchFn: server.fetch as unknown as typeof fetch };
}

afterEach(async () => {
  await disconnectCodex(env);
  vi.unstubAllGlobals();
});

describe("browser login", () => {
  it("builds a PKCE authorize URL for the loopback callback", async () => {
    const started = await startCodexBrowserLogin();
    const url = new URL(started.authorizeUrl);

    expect(`${url.origin}${url.pathname}`).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(started.state);
    expect(started.state).toMatch(/^[0-9a-f]{32}$/);
    // The challenge is the SHA-256 of the verifier, so the pair must agree.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(started.codeVerifier),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    expect(url.searchParams.get("code_challenge")).toBe(expected);
  });

  it("exchanges the loopback code and stores the credential", async () => {
    const { server, fetchFn } = harness();
    let form: URLSearchParams | undefined;
    server.token = (_url, init) => {
      form = new URLSearchParams(String(init?.body));
      return Response.json({
        access_token: "access-browser",
        refresh_token: "refresh-browser",
        expires_in: 3600,
      });
    };

    await completeCodexBrowserLogin(
      {
        code: "code-browser",
        codeVerifier: "verifier-browser",
        state: "0123456789abcdef0123456789abcdef",
      },
      env,
      fetchFn,
    );

    expect(form?.get("grant_type")).toBe("authorization_code");
    expect(form?.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(form?.get("code_verifier")).toBe("verifier-browser");
    expect(await readModelCredential(env, CODEX)).toMatchObject({
      access: "access-browser",
      refresh: "refresh-browser",
    });
  });

  it("refuses a malformed state before touching the network", async () => {
    const { server, fetchFn } = harness();

    await expect(
      completeCodexBrowserLogin(
        { code: "code-browser", codeVerifier: "v", state: "not-a-state" },
        env,
        fetchFn,
      ),
    ).rejects.toThrow(/state is malformed/);
    expect(server.tokenCalls).toBe(0);
  });
});

describe("startCodexLogin", () => {
  it("parses the device code and a string interval", async () => {
    const { fetchFn } = harness();

    expect(await startCodexLogin(fetchFn)).toEqual({
      deviceAuthId: "device-1",
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
      intervalSeconds: 5,
    });
  });

  it("rejects a response without a device code", async () => {
    const { server, fetchFn } = harness();
    server.userCode = () => Response.json({});

    await expect(startCodexLogin(fetchFn)).rejects.toThrow(/missing fields/);
  });
});

describe("pollCodexLogin", () => {
  it("stores the credential and reports done", async () => {
    const { server, fetchFn } = harness();
    server.poll = () =>
      Response.json({ authorization_code: "code-1", code_verifier: "verifier-1" });

    expect(await pollCodexLogin(device, env, fetchFn)).toEqual({ status: "done" });
    expect(await readModelCredential(env, CODEX)).toMatchObject({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
    });
    expect(server.paths).toContain("/oauth/token");
  });

  it("reports pending while the owner has not finished", async () => {
    const { fetchFn } = harness();

    expect(await pollCodexLogin(device, env, fetchFn)).toEqual({ status: "pending" });
    expect(await readModelCredential(env, CODEX)).toBeUndefined();
  });

  it("reports the pending error code as pending and slow_down as slow_down", async () => {
    const { server, fetchFn } = harness();

    server.poll = () =>
      Response.json({ error: { code: "deviceauth_authorization_pending" } }, { status: 400 });
    expect(await pollCodexLogin(device, env, fetchFn)).toEqual({ status: "pending" });

    server.poll = () => Response.json({ error: { code: "slow_down" } }, { status: 400 });
    expect(await pollCodexLogin(device, env, fetchFn)).toEqual({ status: "slow_down" });
  });

  it("throws on an error it cannot classify", async () => {
    const { server, fetchFn } = harness();
    server.poll = () => Response.json({ error: { code: "boom" } }, { status: 400 });

    await expect(pollCodexLogin(device, env, fetchFn)).rejects.toThrow(/boom/);
  });

  it("does not treat an unchanged credential as a finished login", async () => {
    const { server, fetchFn } = harness();
    const stored = { type: "oauth" as const, access: "access-1", refresh: "refresh-1", expires: 1 };
    await saveModelCredential(env, CODEX, stored);
    server.poll = () =>
      Response.json({ authorization_code: "code-1", code_verifier: "verifier-1" });
    server.token = () => new Response("invalid_grant", { status: 400 });

    // The owner signed out and back in; the old credential must not be
    // presented as the result of this login.
    await expect(pollCodexLogin(device, env, fetchFn)).rejects.toThrow(/exchange/);
    expect(await readModelCredential(env, CODEX)).toEqual(stored);
  });

  it("accepts a credential another poll stored during the exchange", async () => {
    const { server, fetchFn } = harness();
    const stored = { type: "oauth" as const, access: "access-1", refresh: "refresh-1", expires: 1 };
    const rotated = { type: "oauth" as const, access: "access-2", refresh: "refresh-2", expires: 1 };
    await saveModelCredential(env, CODEX, stored);
    server.poll = () =>
      Response.json({ authorization_code: "code-1", code_verifier: "verifier-1" });
    server.token = async () => {
      // A concurrent poll won the race and stored its result first.
      await saveModelCredential(env, CODEX, rotated);
      return new Response("invalid_grant", { status: 400 });
    };

    await expect(pollCodexLogin(device, env, fetchFn)).resolves.toEqual({ status: "done" });
    expect(await readModelCredential(env, CODEX)).toEqual(rotated);
  });

  it("still fails when the exchange fails and nothing was stored", async () => {
    const { server, fetchFn } = harness();
    server.poll = () =>
      Response.json({ authorization_code: "code-1", code_verifier: "verifier-1" });
    server.token = () => new Response("invalid_grant", { status: 400 });

    await expect(pollCodexLogin(device, env, fetchFn)).rejects.toThrow(/exchange/);
    expect(await readModelCredential(env, CODEX)).toBeUndefined();
  });
});

describe("codex credential lifecycle", () => {
  it("reports the login state and clears it on disconnect", async () => {
    expect(await codexStatus(env)).toEqual({ connected: false });

    await saveModelCredential(env, CODEX, {
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: 1,
    });
    expect(await codexStatus(env)).toEqual({ connected: true });

    await disconnectCodex(env);
    expect(await codexStatus(env)).toEqual({ connected: false });
  });

  it("refreshes an expired token once and writes the rotated pair back", async () => {
    const { server, fetchFn } = harness();
    vi.stubGlobal("fetch", fetchFn);
    await saveModelCredential(env, CODEX, {
      type: "oauth",
      access: "stale",
      refresh: "refresh-1",
      expires: 1,
    });
    server.token = () =>
      Response.json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });

    const models = createModelsForEnv(env);
    const [first, second] = await Promise.all([
      models.getAuth(CODEX),
      models.getAuth(CODEX),
    ]);

    expect(first?.auth.apiKey).toBe("access-2");
    expect(second?.auth.apiKey).toBe("access-2");
    // The second caller must reuse the fresh credential, not mint another.
    expect(server.tokenCalls).toBe(1);
    expect(await readModelCredential(env, CODEX)).toMatchObject({
      access: "access-2",
      refresh: "refresh-2",
    });
  });

  it("fails the call when the refresh token was revoked", async () => {
    const { server, fetchFn } = harness();
    vi.stubGlobal("fetch", fetchFn);
    await saveModelCredential(env, CODEX, {
      type: "oauth",
      access: "stale",
      refresh: "refresh-1",
      expires: 1,
    });
    server.token = () => new Response("invalid_grant", { status: 400 });

    const models = createModelsForEnv(env);
    await expect(models.getAuth(CODEX)).rejects.toThrow(/OAuth refresh failed/);
  });
});

describe("access token", () => {
  it("returns a live token with its account id and does not refresh", async () => {
    const { server, fetchFn } = harness();
    const access = fakeCodexToken();
    await saveModelCredential(env, CODEX, {
      type: "oauth",
      access,
      refresh: "refresh-0",
      expires: Date.now() + 3_600_000,
    });

    expect(await codexAccessToken(env, AbortSignal.timeout(5_000), fetchFn)).toEqual({
      access,
      accountId: "acct-1",
    });
    expect(server.tokenCalls).toBe(0);
  });

  it("refreshes inside the shared lock when the token is about to expire", async () => {
    const { server, fetchFn } = harness();
    const refreshed = fakeCodexToken();
    server.token = () =>
      Response.json({
        access_token: refreshed,
        refresh_token: "refresh-1",
        expires_in: 3600,
      });
    await saveModelCredential(env, CODEX, {
      type: "oauth",
      access: "stale-access",
      refresh: "refresh-0",
      expires: Date.now() + 60_000,
    });

    expect(await codexAccessToken(env, AbortSignal.timeout(5_000), fetchFn)).toEqual({
      access: refreshed,
      accountId: "acct-1",
    });
    expect(server.tokenCalls).toBe(1);
    expect(await readModelCredential(env, CODEX)).toMatchObject({
      type: "oauth",
      access: refreshed,
      refresh: "refresh-1",
    });

    // The refreshed credential is live, so the next call must not refresh again:
    // OpenAI rotates refresh tokens and a second refresh would kill the session.
    await codexAccessToken(env, AbortSignal.timeout(5_000), fetchFn);
    expect(server.tokenCalls).toBe(1);
  });

  it("reports not signed in without a credential", async () => {
    const { fetchFn } = harness();
    expect(
      await codexAccessToken(env, AbortSignal.timeout(5_000), fetchFn),
    ).toBeUndefined();
  });

  it("treats a token it cannot decode as not signed in", async () => {
    const { fetchFn } = harness();
    await saveModelCredential(env, CODEX, {
      type: "oauth",
      access: "not-a-jwt",
      refresh: "refresh-0",
      expires: Date.now() + 3_600_000,
    });
    expect(
      await codexAccessToken(env, AbortSignal.timeout(5_000), fetchFn),
    ).toBeUndefined();
  });

  it("treats a token without the account claim as not signed in", async () => {
    const { fetchFn } = harness();
    await saveModelCredential(env, CODEX, {
      type: "oauth",
      access: fakeCodexToken({ sub: "user-1" }),
      refresh: "refresh-0",
      expires: Date.now() + 3_600_000,
    });
    expect(
      await codexAccessToken(env, AbortSignal.timeout(5_000), fetchFn),
    ).toBeUndefined();
  });

  it("refreshes once when pi refreshes at the same moment", async () => {
    const { server, fetchFn } = harness();
    const refreshed = fakeCodexToken();
    server.token = () =>
      Response.json({
        access_token: refreshed,
        refresh_token: "refresh-1",
        expires_in: 3600,
      });
    vi.stubGlobal("fetch", fetchFn);
    await saveModelCredential(env, CODEX, {
      type: "oauth",
      access: "stale-access",
      refresh: "refresh-0",
      expires: Date.now() + 60_000,
    });

    // Both callers reach the same credential store, so the second one queues
    // behind the first and finds a credential that no longer needs a refresh.
    // Two refreshes would rotate the token twice and sign the session out.
    const [auth, token] = await Promise.all([
      createModelsForEnv(env).getAuth(CODEX),
      codexAccessToken(env, AbortSignal.timeout(5_000)),
    ]);

    expect(server.tokenCalls).toBe(1);
    expect(token?.access).toBe(refreshed);
    expect(auth).toMatchObject({ auth: { apiKey: refreshed } });
  });

  it("surfaces a failed refresh instead of handing back a dead token", async () => {
    const { server, fetchFn } = harness();
    server.token = () => new Response("invalid_grant", { status: 400 });
    await saveModelCredential(env, CODEX, {
      type: "oauth",
      access: "stale-access",
      refresh: "refresh-0",
      expires: Date.now(),
    });
    await expect(
      codexAccessToken(env, AbortSignal.timeout(5_000), fetchFn),
    ).rejects.toThrow(/refresh/);
  });
});
