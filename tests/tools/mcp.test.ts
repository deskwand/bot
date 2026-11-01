import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { McpServerConfig } from "../../src/config";
import type { TaskEventBody } from "../../src/protocol";
import type { ApprovalGateLike } from "../../src/task/approvals";
import { describe, expect, it, vi } from "vitest";
import {
  loadMcpTools,
  type McpCallToolResult,
  type McpClientLike,
  type McpConnector,
  type McpToolInfo,
} from "../../src/tools/mcp";

const notionTools: McpToolInfo[] = [
  {
    name: "create_page",
    description: "Create a Notion page",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "search",
    description: "Search Notion",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
  },
];

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "notion",
    url: "https://mcp.notion.test/mcp",
    requireApproval: ["create_page"],
    ...overrides,
  };
}

function context(): Context {
  return { abortSignal: undefined } as unknown as Context;
}

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

function fakeClient(calls: string[]): McpClientLike {
  return {
    async listTools() {
      return notionTools;
    },
    async callTool(name, args): Promise<McpCallToolResult> {
      calls.push(`${name}:${JSON.stringify(args)}`);
      return { content: [{ type: "text", text: `ran ${name}` }] };
    },
  };
}

function gate(decision: "approved" | "rejected"): ApprovalGateLike & {
  requests: { tool: string; args: unknown }[];
} {
  const requests: { tool: string; args: unknown }[] = [];
  return {
    requests,
    async request(tool, args) {
      requests.push({ tool, args });
      return decision;
    },
    async resolve() {
      return { ok: true, message: "" };
    },
  };
}

function recorder(): {
  emit: (body: TaskEventBody) => Promise<void>;
  events: TaskEventBody[];
} {
  const events: TaskEventBody[] = [];
  return {
    events,
    async emit(body) {
      events.push(body);
    },
  };
}

describe("loadMcpTools", () => {
  it("namespaces tools per server and wraps the approval-listed ones", async () => {
    const calls: string[] = [];
    const client = fakeClient(calls);
    const approval = gate("rejected");
    const connect: McpConnector = async () => client;
    const progress = recorder();

    const tools = await loadMcpTools([server()], approval, connect, progress.emit);

    expect(tools.map((tool) => tool.name)).toEqual([
      "notion__create_page",
      "notion__search",
    ]);
    expect(
      (tools[0]?.parameters as { properties?: Record<string, unknown> })
        .properties,
    ).toHaveProperty("title");
    expect(tools[0]?.replay).toBeUndefined();
    expect(tools[1]?.replay).toBeUndefined();

    const rejected = await tools[0]!.execute(
      { title: "Hello" },
      {} as never,
      context(),
    );
    expect(textOf(rejected)).toContain("用户拒绝");
    expect(approval.requests).toEqual([
      { tool: "notion__create_page", args: { title: "Hello" } },
    ]);
    expect(calls).toEqual([]);

    const searched = await tools[1]!.execute(
      { query: "notes" },
      {} as never,
      context(),
    );
    expect(textOf(searched)).toBe("ran search");
    expect(approval.requests).toHaveLength(1);
    expect(calls).toEqual(['search:{"query":"notes"}']);
    expect(progress.events).toEqual([
      { type: "progress", text: "MCP notion：create_page" },
      { type: "progress", text: "MCP notion：search" },
    ]);
  });

  it("runs the approved tool and forwards the abort signal", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const client: McpClientLike = {
      async listTools() {
        return notionTools;
      },
      async callTool(name, _args, signal) {
        seen.push(signal);
        return { content: [{ type: "text", text: `ran ${name}` }] };
      },
    };
    const controller = new AbortController();

    const tools = await loadMcpTools(
      [server()],
      gate("approved"),
      async () => client,
      recorder().emit,
    );
    const result = await tools[0]!.execute(
      { title: "Hello" },
      {} as never,
      { abortSignal: controller.signal } as unknown as Context,
    );

    expect(textOf(result)).toBe("ran create_page");
    expect(seen).toEqual([controller.signal]);
  });

  it("converts MCP errors and non-text content", async () => {
    const client: McpClientLike = {
      async listTools() {
        return [{ name: "search" }];
      },
      async callTool() {
        return {
          isError: true,
          content: [{ type: "resource", uri: "x://y" }],
        };
      },
    };

    const tools = await loadMcpTools(
      [server({ requireApproval: [] })],
      gate("approved"),
      async () => client,
      recorder().emit,
    );
    const result = await tools[0]!.execute({}, {} as never, context());

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("x://y");
  });

  it("skips an unreachable server without throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const connect: McpConnector = async (server) => {
      if (server.name === "broken") throw new Error("connect refused");
      return fakeClient(calls);
    };

    const tools = await loadMcpTools(
      [server(), server({ name: "broken", url: "https://broken.test" })],
      gate("approved"),
      connect,
      recorder().emit,
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "notion__create_page",
      "notion__search",
    ]);
    expect(error).toHaveBeenCalled();
    expect(error.mock.calls[0]?.[0]).toContain("broken");
    error.mockRestore();
  });

  it("skips a server that never answers within the timeout", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const connect: McpConnector = (server) =>
      server.name === "slow"
        ? new Promise<McpClientLike>(() => {})
        : Promise.resolve(fakeClient(calls));

    const started = Date.now();
    const tools = await loadMcpTools(
      [server({ name: "slow", url: "https://slow.test" }), server()],
      gate("approved"),
      connect,
      recorder().emit,
      50,
    );
    const elapsed = Date.now() - started;

    expect(tools.map((tool) => tool.name)).toEqual([
      "notion__create_page",
      "notion__search",
    ]);
    expect(elapsed).toBeLessThan(2000);
    expect(error.mock.calls[0]?.[0]).toContain("slow");
    error.mockRestore();
  });

  it("returns no tools without a server or a connection attempt", async () => {
    const connect = vi.fn<McpConnector>();

    await expect(
      loadMcpTools([], gate("approved"), connect, recorder().emit),
    ).resolves.toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });
});
