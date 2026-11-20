import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexStatus,
  disconnectCodex,
  pollCodexLogin,
  startCodexLogin,
} from "../../src/llm/codex";
import { readModelCredential, saveModelCredential } from "../../src/llm/model-auth";
import { createModelsForEnv } from "../../src/llm/models";

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
