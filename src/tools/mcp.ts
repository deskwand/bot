import {
  normalizeServerId,
  type MCPClientManager,
} from "agents/mcp/client";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type {
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { McpServerConfig } from "../config";
import type { TaskEventBody } from "../protocol";
import { withApproval, type ApprovalGateLike } from "../task/approvals";
import { withProgress } from "./wrap";

/** How long one MCP server may take to connect and list its tools. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** The subset of an MCP tool definition this module needs. */
export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/** The subset of an MCP `tools/call` result this module needs. */
export type McpCallToolResult = {
  content?: unknown;
  isError?: boolean;
};

/**
 * Minimal MCP client surface. The real implementation wraps the Agents SDK
 * `MCPClientManager`; tests inject a fake so no network is needed.
 */
export type McpClientLike = {
  listTools(): Promise<readonly McpToolInfo[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<McpCallToolResult>;
};

export type McpConnector = (server: McpServerConfig) => Promise<McpClientLike>;

type McpContentItem = {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reject instead of hanging when a server never answers. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Convert an MCP result's content into pi tool output. */
function toToolResult(result: McpCallToolResult): ToolExecutionResult {
  const content = Array.isArray(result.content)
    ? (result.content as McpContentItem[])
    : [];

  const output = content.map((item) => {
    if (item.type === "text" && typeof item.text === "string") {
      return { type: "text" as const, text: item.text };
    }
    if (
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      return { type: "image" as const, data: item.data, mimeType: item.mimeType };
    }
    return { type: "text" as const, text: JSON.stringify(item) };
  });

  if (output.length === 0) {
    output.push({
      type: "text",
      text: result.isError ? "MCP 工具返回错误" : "（无输出）",
    });
  }

  return { output, isError: result.isError };
}

/**
 * Build a connector backed by an `Agent`'s MCP client manager. Servers are
 * registered under a stable, normalized id so tools can be scoped to them.
 */
export function mcpConnector(manager: MCPClientManager): McpConnector {
  return async (server) => {
    const id = normalizeServerId(server.name);
    await manager.registerServer(id, {
      url: server.url,
      name: server.name,
      transport: server.headers
        ? { requestInit: { headers: server.headers } }
        : undefined,
    });

    const connection = await manager.connectToServer(id);
    if (connection.state === "authenticating") {
      throw new Error(`MCP server ${server.name} requires authentication`);
    }
    if (connection.state === "failed") {
      throw new Error(
        `MCP server ${server.name} connection failed: ${connection.error}`,
      );
    }

    const discovered = await manager.discoverIfConnected(id);
    if (discovered && !discovered.success) {
      throw new Error(
        `MCP server ${server.name} discovery failed: ${discovered.error ?? "unknown error"}`,
      );
    }

    return {
      async listTools() {
        return manager.listTools({ serverId: id }).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }));
      },
      async callTool(name, args, signal) {
        return manager.callTool(
          { serverId: id, name, arguments: args },
          { signal },
        );
      },
    };
  };
}

/**
 * Connect to every configured MCP server and expose its tools to pi.
 *
 * Tool names are `<server>__<tool>`; tools listed in the server's
 * `requireApproval` run through the approval gate, and every tool reports
 * progress first like the builtin tools. A server that cannot be reached (or
 * does not answer within `timeoutMs`) is logged and skipped so one broken
 * integration cannot block the task. MCP tools have unknown side effects, so
 * none is marked replay-safe.
 */
export async function loadMcpTools(
  servers: McpServerConfig[],
  gate: ApprovalGateLike,
  connect: McpConnector,
  emit: (body: TaskEventBody) => Promise<void>,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<ToolRegistration[]> {
  const tools: ToolRegistration[] = [];

  for (const server of servers) {
    try {
      const client = await withTimeout(
        connect(server),
        timeoutMs,
        `mcp server ${server.name} connect`,
      );
      const listed = await withTimeout(
        client.listTools(),
        timeoutMs,
        `mcp server ${server.name} listTools`,
      );
      for (const info of listed) {
        const toolName = `${server.name}__${info.name}`;
        let tool: ToolRegistration = {
          name: toolName,
          description:
            info.description ?? `${server.name} MCP tool: ${info.name}`,
          parameters: Type.Unsafe<Record<string, unknown>>(
            (info.inputSchema ?? { type: "object" }) as TSchema,
          ),
          execute: async (args: Static<TSchema>, _api, context) => {
            const result = await client.callTool(
              info.name,
              args as Record<string, unknown>,
              context.abortSignal,
            );
            return toToolResult(result);
          },
        };

        if (server.requireApproval?.includes(info.name)) {
          tool = withApproval(tool, gate);
        }
        tools.push(
          withProgress(tool, emit, () => `MCP ${server.name}：${info.name}`),
        );
      }
    } catch (error) {
      console.error(
        `mcp server ${server.name} unavailable: ${errorMessage(error)}`,
      );
    }
  }

  return tools;
}
