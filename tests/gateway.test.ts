import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createGateway } from "../src/gateway";
import type { McpAuthDO } from "../src/mcp/mcp-auth-do";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function setup(
  mcpAuth: () => DurableObjectStub<McpAuthDO> = () =>
    env.MCP_AUTH.get(env.MCP_AUTH.idFromName("gateway-test")),
) {
  const gateway = createGateway({
    artifacts: env.ARTIFACTS,
    admin: { fetch: async () => new Response(null, { status: 404 }) },
    mcpAuth,
  });
  return { gateway };
}

describe("GET /a/<key>", () => {
  it("no longer serves the former public artifact path", async () => {
    await env.ARTIFACTS.put("t1/u/r.md", "hi", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    const h = setup();

    const response = await h.gateway.fetch(
      new Request("https://example.com/a/t1/u/r.md"),
    );

    expect(response.status).toBe(404);
  });
});

describe("GET /mcp/oauth/callback", () => {
  it("serves the success page without admin authentication", async () => {
    const auth = {
      completeAuthorization: async () => true,
    } as unknown as DurableObjectStub<McpAuthDO>;
    const h = setup(() => auth);

    const response = await h.gateway.fetch(
      new Request(
        "https://example.com/mcp/oauth/callback?code=code-1&state=state-1",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("授权完成，可以回到桌面端了");
  });

  it("serves the failure page when state or code is missing", async () => {
    const h = setup();

    const response = await h.gateway.fetch(
      new Request("https://example.com/mcp/oauth/callback"),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("授权失败，请回到桌面端重试");
  });
});

describe("worker entry", () => {
  it("returns 404 for unknown paths", async () => {
    const response = await SELF.fetch("https://example.com/unknown");

    expect(response.status).toBe(404);
  });

  it("answers 404 for the removed Telegram webhook", async () => {
    const response = await SELF.fetch("https://example.com/telegram/webhook", {
      method: "POST",
    });

    expect(response.status).toBe(404);
  });

  it("answers 404 for the former public artifact path", async () => {
    await env.ARTIFACTS.put("cfg/missing/r.md", "still served", {
      httpMetadata: { contentType: "text/markdown" },
    });
    const response = await SELF.fetch(
      "https://example.com/a/cfg/missing/r.md",
    );

    expect(response.status).toBe(404);
  });
});
