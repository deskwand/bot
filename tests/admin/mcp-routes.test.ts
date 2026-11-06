import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createAdminGateway,
  type AdminDeps,
} from "../../src/admin/admin-gateway";
import { createMcpAdminRoutes } from "../../src/admin/mcp-routes";
import type { McpAuthDO } from "../../src/mcp/mcp-auth-do";
import { McpUserError, type McpUserErrorCode } from "../../src/mcp/errors";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "test-admin-token";
const OP = "op-mcp";

type Calls = {
  probe: string[];
  start: string[];
  revoke: string[];
  complete: [string, string][];
};

type FakeOptions = {
  complete?: boolean;
  startError?: McpUserErrorCode;
};

function fakeAuth(options: FakeOptions = {}): {
  calls: Calls;
  stub: DurableObjectStub<McpAuthDO>;
} {
  const calls: Calls = { probe: [], start: [], revoke: [], complete: [] };
  const stub = {
    probe: async (name: string) => {
      calls.probe.push(name);
      return { ok: true, tools: [] };
    },
    startAuthorization: async (name: string) => {
      calls.start.push(name);
      if (options.startError !== undefined) {
        throw new McpUserError(options.startError);
      }
      return { url: "https://auth.test/authorize?state=s" };
    },
    status: async () => [{ name: "notion", state: "unauthorized" }],
    revoke: async (name: string) => {
      calls.revoke.push(name);
    },
    completeAuthorization: async (state: string, code: string) => {
      calls.complete.push([state, code]);
      return options.complete ?? false;
    },
  };
  return { calls, stub: stub as unknown as DurableObjectStub<McpAuthDO> };
}

function deps(
  stub: DurableObjectStub<McpAuthDO>,
  token: string | null = TOKEN,
  name = "mcp-routes",
): AdminDeps {
  return {
    token: token ?? undefined,
    versionId: "version-test",
    butler: () => env.BUTLER.get(env.BUTLER.idFromName(name)),
    channel: () =>
      env.CHANNELS.get(env.CHANNELS.idFromName(`${name}-channels`)),
    task: (id) => env.TASK.get(env.TASK.idFromName(id)),
    bot: (id) => env.BOT.get(env.BOT.idFromName(id)),
    artifacts: env.ARTIFACTS,
    mcpAuth: () => stub,
  };
}

function call(
  gateway: { fetch(req: Request): Promise<Response> },
  path: string,
  init: {
    method?: string;
    body?: unknown;
    token?: string | null;
    opId?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (init.opId !== undefined) headers.set("x-backup-op", init.opId);
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return gateway.fetch(
    new Request(`https://example.com${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

describe("/admin/mcp/*", () => {
  it("requires the admin bearer token", async () => {
    const { stub } = fakeAuth();
    const gateway = createAdminGateway(deps(stub));

    const missing = await call(gateway, "/admin/mcp/status", { token: null });
    const wrong = await call(gateway, "/admin/mcp/status", { token: "nope" });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ code: "ADMIN_UNAUTHORIZED" });
  });

  it("answers status while a maintenance lease is active, without a lease", async () => {
    const { stub } = fakeAuth();
    const gateway = createAdminGateway(deps(stub));

    const acquired = await call(gateway, "/admin/maintenance/acquire", {
      method: "POST",
      body: { op: "export", opId: OP },
    });
    expect(acquired.status).toBe(200);

    const response = await call(gateway, "/admin/mcp/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      servers: [{ name: "notion", state: "unauthorized" }],
    });
  });

  it("probes a server", async () => {
    const { calls, stub } = fakeAuth();
    const gateway = createAdminGateway(deps(stub));

    const response = await call(gateway, "/admin/mcp/probe", {
      method: "POST",
      body: { name: "deepwiki" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, tools: [] });
    expect(calls.probe).toEqual(["deepwiki"]);
  });

  it("starts authorization and returns the URL", async () => {
    const { calls, stub } = fakeAuth();
    const gateway = createAdminGateway(deps(stub));

    const response = await call(gateway, "/admin/mcp/oauth/start", {
      method: "POST",
      body: { name: "notion" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://auth.test/authorize?state=s",
    });
    expect(calls.start).toEqual(["notion"]);
  });

  it("returns a code when the service needs no authorization", async () => {
    const { stub } = fakeAuth({
      startError: "MCP_SERVER_NOT_FOUND_OR_NO_AUTH",
    });
    const gateway = createAdminGateway(deps(stub));

    const response = await call(gateway, "/admin/mcp/oauth/start", {
      method: "POST",
      body: { name: "deepwiki" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "MCP_SERVER_NOT_FOUND_OR_NO_AUTH",
      error: "服务不存在或不需要授权",
    });
  });

  it("tells the desktop when a service does not support DCR", async () => {
    const { stub } = fakeAuth({ startError: "MCP_DCR_UNSUPPORTED" });
    const gateway = createAdminGateway(deps(stub));

    const response = await call(gateway, "/admin/mcp/oauth/start", {
      method: "POST",
      body: { name: "asana" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "MCP_DCR_UNSUPPORTED",
      error: "该服务不支持自动注册（DCR）",
    });
  });

  it("localizes the coded error", async () => {
    const { stub } = fakeAuth({ startError: "MCP_SERVER_NOT_FOUND" });
    const zh = createAdminGateway(deps(stub));
    const en = createAdminGateway({ ...deps(stub), locale: () => "en" });

    const zhResponse = await call(zh, "/admin/mcp/oauth/start", {
      method: "POST",
      body: { name: "missing" },
    });
    const enResponse = await call(en, "/admin/mcp/oauth/start", {
      method: "POST",
      body: { name: "missing" },
    });

    expect(zhResponse.status).toBe(400);
    expect(await zhResponse.json()).toEqual({
      code: "MCP_SERVER_NOT_FOUND",
      error: "服务不存在",
    });
    expect(enResponse.status).toBe(400);
    const body = (await enResponse.json()) as { code: string; error: string };
    expect(body).toEqual({
      code: "MCP_SERVER_NOT_FOUND",
      error: "Service not found",
    });
    expect(body.error).not.toMatch(/\p{Script=Han}/u);
  });

  it("revokes a server", async () => {
    const { calls, stub } = fakeAuth();
    const gateway = createAdminGateway(deps(stub));

    const response = await call(gateway, "/admin/mcp/oauth/notion", {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(calls.revoke).toEqual(["notion"]);
  });

  it("hides unexpected failures behind a fixed error", async () => {
    const stub = {
      status: async () => {
        throw new Error("token=secret");
      },
    } as unknown as DurableObjectStub<McpAuthDO>;
    const gateway = createAdminGateway(deps(stub));

    const response = await call(gateway, "/admin/mcp/status");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "MCP_FAILED",
      message: "mcp request failed",
    });
  });
});

describe("GET /mcp/oauth/callback", () => {
  it("shows the success page and redeems the code", async () => {
    const { calls, stub } = fakeAuth({ complete: true });
    const routes = createMcpAdminRoutes(() => stub);

    const response = await routes.fetch(
      new Request(
        "https://example.com/mcp/oauth/callback?code=code-1&state=state-1",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain("授权完成，可以回到桌面端了");
    expect(text).toContain(
      "Authorization complete. You can return to the desktop app.",
    );
    expect(calls.complete).toEqual([["state-1", "code-1"]]);
  });

  it("shows the failure page for a rejected callback", async () => {
    const { stub } = fakeAuth({ complete: false });
    const routes = createMcpAdminRoutes(() => stub);

    const response = await routes.fetch(
      new Request(
        "https://example.com/mcp/oauth/callback?code=code-1&state=state-1",
      ),
    );

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("授权失败，请回到桌面端重试");
    expect(text).toContain(
      "Authorization failed. Return to the desktop app and try again.",
    );
  });

  it("shows the failure page without echoing a missing code or state", async () => {
    const { calls, stub } = fakeAuth({ complete: true });
    const routes = createMcpAdminRoutes(() => stub);

    const noCode = await routes.fetch(
      new Request(
        "https://example.com/mcp/oauth/callback?state=state-secret-value",
      ),
    );
    const noState = await routes.fetch(
      new Request(
        "https://example.com/mcp/oauth/callback?code=code-secret-value",
      ),
    );

    expect(noCode.status).toBe(400);
    expect(noState.status).toBe(400);
    const text = `${await noCode.text()}${await noState.text()}`;
    expect(text).toContain("授权失败，请回到桌面端重试");
    expect(text).not.toContain("state-secret-value");
    expect(text).not.toContain("code-secret-value");
    expect(calls.complete).toEqual([]);
  });
});
