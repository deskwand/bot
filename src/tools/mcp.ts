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
  annotations?: { readOnlyHint?: boolean };
};

/** How the loader treats one tool of a server. */
export type McpToolMode = "disabled" | "approval" | "auto";

/** A configured server that could not be loaded for this run. */
export type McpUnavailable = { name: string; reason: string };

/** Result of the desktop's "test connection" action. */
export type McpProbeResult =
  | {
      ok: true;
      tools: { name: string; description: string; mode: McpToolMode }[];
    }
  | { ok: false; reason: string };

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

/** Resolves a server's Bearer token; null means "not authorized". */
export type McpBearer = (server: McpServerConfig) => Promise<string | null>;

type McpContentItem = {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An OAuth server could not be connected because it has no usable token. */
class McpUnauthorizedError extends Error {
  constructor() {
    super("需要在桌面端登录授权");
    this.name = "McpUnauthorizedError";
  }
}

/** User-facing reason for a server that failed to load. */
function unavailableReason(error: unknown): string {
  return error instanceof McpUnauthorizedError
    ? error.message
    : errorMessage(error);
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
 * Replace `{env:NAME}` placeholders in a server URL with their values. A
 * missing variable fails the connection attempt without revealing any secret,
 * which `loadMcpTools` reports and skips.
 */
export function resolveMcpUrl(server: McpServerConfig, env: object): string {
  return server.url.replace(/\{env:([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = (env as Record<string, unknown>)[name];
    if (typeof value !== "string") {
      throw new Error(
        `MCP server ${server.name} is missing environment variable ${name}`,
      );
    }
    return encodeURIComponent(value);
  });
}

/**
 * Decide how a tool is treated, in the order the design document gives:
 * disabled, forced approval, forced auto, the `writes` policy, then legacy
 * auto approval.
 */
export function mcpToolMode(
  server: McpServerConfig,
  tool: McpToolInfo,
): McpToolMode {
  if (server.disabledTools?.includes(tool.name)) return "disabled";
  if (server.requireApproval?.includes(tool.name)) return "approval";
  if (server.autoApprove?.includes(tool.name)) return "auto";
  if (server.approvalPolicy === "writes") {
    return tool.annotations?.readOnlyHint === true ? "auto" : "approval";
  }
  return "auto";
}

/**
 * Build the model-facing tool name `<server>__<tool>`. Characters outside the
 * model's accepted set become `_`; names over 64 characters are unusable.
 */
export function mcpToolName(server: string, tool: string): string | null {
  const name = `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return name.length > 64 ? null : name;
}

/**
 * Resolve `env:NAME` header values from the Worker environment so secrets do
 * not have to live in the committed config. A missing variable fails the
 * server's connection attempt, which `loadMcpTools` reports and skips.
 */
export function resolveMcpHeaders(
  server: McpServerConfig,
  env: object,
): Record<string, string> | undefined {
  if (!server.headers) return undefined;

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.headers)) {
    if (!value.startsWith("env:")) {
      headers[key] = value;
      continue;
    }

    const name = value.slice("env:".length);
    const secret = (env as Record<string, unknown>)[name];
    if (typeof secret !== "string") {
      throw new Error(
        `MCP server ${server.name} is missing environment variable ${name}`,
      );
    }
    headers[key] = secret;
  }
  return headers;
}

/**
 * Build a connector backed by an `Agent`'s MCP client manager. Servers are
 * registered under a stable, normalized id so tools can be scoped to them.
 * Header values of the form `env:NAME` are read from `env` at connect time.
 * OAuth servers get their Bearer token from `bearer` instead of the config.
 */
export function mcpConnector(
  manager: MCPClientManager,
  env: object = {},
  bearer: McpBearer = async () => null,
): McpConnector {
  return async (server) => {
    const id = normalizeServerId(server.name);
    let headers = resolveMcpHeaders(server, env);
    if (server.oauth) {
      const token = await bearer(server);
      if (token === null) throw new McpUnauthorizedError();
      headers = { ...headers, Authorization: `Bearer ${token}` };
    }

    await manager.registerServer(id, {
      url: resolveMcpUrl(server, env),
      name: server.name,
      transport: headers ? { requestInit: { headers } } : undefined,
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
          annotations: tool.annotations,
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
 * Tool names are `<server>__<tool>`; `mcpToolMode` decides whether a tool is
 * skipped, gated behind approval, or runs directly, and every loaded tool
 * reports progress first like the builtin tools. Servers connect concurrently
 * and one that cannot be reached (or does not answer within `timeoutMs`) is
 * logged and reported as unavailable so one broken integration cannot block
 * the task or the others. MCP tools have unknown side effects, so none is
 * marked replay-safe.
 */
export async function loadMcpTools(
  servers: McpServerConfig[],
  gate: ApprovalGateLike,
  connect: McpConnector,
  emit: (body: TaskEventBody) => Promise<void>,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<{ tools: ToolRegistration[]; unavailable: McpUnavailable[] }> {
  const enabled = servers.filter((server) => server.enabled !== false);
  const results = await Promise.allSettled(
    enabled.map((server) =>
      loadServerTools(server, gate, connect, emit, timeoutMs),
    ),
  );

  const tools: ToolRegistration[] = [];
  const unavailable: McpUnavailable[] = [];
  results.forEach((result, index) => {
    const server = enabled[index]!;
    if (result.status === "fulfilled") {
      tools.push(...result.value);
      return;
    }

    const reason = unavailableReason(result.reason);
    console.error(`mcp server ${server.name} unavailable: ${reason}`);
    unavailable.push({ name: server.name, reason });
  });

  return { tools, unavailable };
}

/** Connect one server and build its tools; rejects with the failure reason. */
async function loadServerTools(
  server: McpServerConfig,
  gate: ApprovalGateLike,
  connect: McpConnector,
  emit: (body: TaskEventBody) => Promise<void>,
  timeoutMs: number,
): Promise<ToolRegistration[]> {
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

  const tools: ToolRegistration[] = [];
  const used = new Set<string>();
  for (const info of listed) {
    const mode = mcpToolMode(server, info);
    if (mode === "disabled") continue;

    const toolName = mcpToolName(server.name, info.name);
    if (toolName === null) {
      console.error(
        `mcp server ${server.name} tool ${info.name} skipped: name over 64 characters`,
      );
      continue;
    }
    if (used.has(toolName)) {
      console.error(
        `mcp server ${server.name} tool ${info.name} skipped: name ${toolName} collides`,
      );
      continue;
    }
    used.add(toolName);

    let tool: ToolRegistration = {
      name: toolName,
      description: info.description ?? `${server.name} MCP tool: ${info.name}`,
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

    if (mode === "approval") {
      tool = withApproval(tool, gate);
    }
    tools.push(
      withProgress(tool, emit, () => `MCP ${server.name}：${info.name}`),
    );
  }

  return tools;
}

/**
 * Connect one server for the desktop's "test connection" action. Shares the
 * loader's URL resolution and tool decision logic, but reports the failure
 * reason instead of throwing.
 */
export async function probeMcpServer(
  server: McpServerConfig,
  connect: McpConnector,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<McpProbeResult> {
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

    return {
      ok: true,
      tools: listed.map((info) => ({
        name: info.name,
        description: info.description ?? "",
        mode: mcpToolMode(server, info),
      })),
    };
  } catch (error) {
    return { ok: false, reason: unavailableReason(error) };
  }
}

/** One notice line naming every server skipped in this run, if any. */
export function unavailableNotice(
  unavailable: McpUnavailable[],
): string | undefined {
  if (unavailable.length === 0) return undefined;
  const parts = unavailable.map((item) => `${item.name}（${item.reason}）`);
  return `以下服务本次不可用：${parts.join("；")}`;
}
