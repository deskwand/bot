import { createMcpAdminRoutes } from "./admin/mcp-routes";
import type { ArtifactStore } from "./artifact-store";
import type { Locale } from "./i18n";
import type { McpAuthDO } from "./mcp/mcp-auth-do";

export type GatewayDeps = {
  artifacts: ArtifactStore;
  admin: { fetch(req: Request): Promise<Response> };
  mcpAuth(): DurableObjectStub<McpAuthDO>;
  locale?: () => Locale;
};

const MCP_CALLBACK_PATH = "/mcp/oauth/callback";

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

export function createGateway(deps: GatewayDeps): {
  fetch(req: Request): Promise<Response>;
} {
  const mcp = createMcpAdminRoutes(deps.mcpAuth, deps.locale);

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname.startsWith("/admin/")) {
        return deps.admin.fetch(req);
      }

      if (req.method === "GET" && url.pathname === MCP_CALLBACK_PATH) {
        return mcp.fetch(req);
      }

      return notFound();
    },
  };
}
