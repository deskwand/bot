import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpAdminRoutes } from "../../src/admin/mcp-routes";
import type { McpAuthDO } from "../../src/mcp/mcp-auth-do";
import {
  mcpAuthRequiredText,
  mcpErrorText,
  mcpReauthNotice,
} from "../../src/mcp/owner-copy";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const HAN = /\p{Script=Han}/u;
const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

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

function configFor(locale?: string): unknown {
  return {
    schemaVersion: 1,
    owner: { telegramUserIds: [100000001] },
    models: {
      butler: { provider: "deepseek", id: "deepseek-flash" },
      task: { provider: "deepseek", id: "deepseek-flash" },
    },
    mcpServers: [{ name: "notion", url: "https://mcp.test/mcp", oauth: true }],
    ...(locale === undefined ? {} : { locale }),
  };
}

function expectEnglish(text: string): void {
  expect(text).not.toMatch(HAN);
}

function authStub(name: string) {
  return env.MCP_AUTH.get(env.MCP_AUTH.idFromName(name));
}

beforeEach(() => {
  setEnv({ DESKWAND_CONFIG: configFor() });
});

afterEach(() => {
  restoreEnv();
});

describe("MCP owner copy", () => {
  it("keeps the Chinese copy", () => {
    expect(mcpErrorText("zh", "MCP_SERVER_NOT_FOUND")).toBe("服务不存在");
    expect(mcpErrorText("zh", "MCP_SERVER_NOT_FOUND_OR_NO_AUTH")).toBe(
      "服务不存在或不需要授权",
    );
    expect(mcpErrorText("zh", "MCP_DCR_UNSUPPORTED")).toBe(
      "该服务不支持自动注册（DCR）",
    );
    expect(mcpAuthRequiredText("zh")).toBe("需要在桌面端登录授权");
    expect(mcpReauthNotice("zh", "notion")).toBe(
      "notion 授权已失效，请在桌面端重新登录",
    );
  });

  it("follows the locale", () => {
    const english = [
      mcpErrorText("en", "MCP_SERVER_NOT_FOUND"),
      mcpErrorText("en", "MCP_SERVER_NOT_FOUND_OR_NO_AUTH"),
      mcpErrorText("en", "MCP_DCR_UNSUPPORTED"),
      mcpAuthRequiredText("en"),
      mcpReauthNotice("en", "notion"),
    ];
    for (const text of english) expectEnglish(text);
    expect(mcpErrorText("en", "MCP_SERVER_NOT_FOUND")).toBe("Service not found");
    expect(mcpReauthNotice("en", "notion")).toContain("notion");
    expect(mcpReauthNotice("en", "notion")).not.toContain("🔑");
  });
});

describe("McpAuthDO locale", () => {
  it("localizes probe reasons and keeps their codes", async () => {
    setEnv({ DESKWAND_CONFIG: configFor("en") });

    await runInDurableObject(authStub("mcp-locale-probe"), async (instance) => {
      expect(await instance.probe("notion")).toEqual({
        ok: false,
        auth: "unauthorized",
        reason: "Sign in from the desktop app to authorize",
        reasonCode: "MCP_AUTH_REQUIRED",
      });

      const missing = await instance.probe("missing");
      expect(missing).toEqual({
        ok: false,
        reason: "Service not found",
        reasonCode: "MCP_SERVER_NOT_FOUND",
      });
      if (missing.ok) throw new Error("expected a failed probe");
      expectEnglish(missing.reason);
    });
  });

  it("keeps the authorization error code across Durable Object RPC", async () => {
    setEnv({ DESKWAND_CONFIG: configFor("en") });
    const routes = createMcpAdminRoutes(() => authStub("mcp-locale-route"), () => "en");

    const response = await routes.fetch(
      new Request("https://example.com/admin/mcp/oauth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "missing" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "MCP_SERVER_NOT_FOUND",
      message: "Service not found",
    });
  });
});
