import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { McpServerConfig } from "../../src/config";
import type { TaskEventBody } from "../../src/protocol";
import type { ApprovalGateLike } from "../../src/task/approvals";
import { describe, expect, it, vi } from "vitest";
import {
  loadMcpTools,
  mcpConnector,
  mcpToolMode,
  mcpToolName,
  probeMcpServer,
  resolveMcpUrl,
  unavailableNotice,
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

function fakeManager(listed: readonly McpToolInfo[] = []) {
  const registered: Array<{
    id: string;
    config: {
      url: string;
      transport?: { requestInit?: { headers?: Record<string, string> } };
    };
  }> = [];
  const manager = {
    async registerServer(
      id: string,
      config: {
        url: string;
        transport?: { requestInit?: { headers?: Record<string, string> } };
      },
    ) {
      registered.push({ id, config });
    },
    async connectToServer() {
      return { state: "connected" };
    },
    async discoverIfConnected() {
      return { success: true };
    },
    listTools() {
      return listed;
    },
    async callTool() {
      return { content: [] };
    },
  } as unknown as Parameters<typeof mcpConnector>[0];
  return { manager, registered };
}

describe("resolveMcpUrl", () => {
  it("resolves {env:NAME} in the URL and names a missing variable without its value", () => {
    const s = server({ url: "https://mcp.amap.test/sse?key={env:MCP_AMAP_KEY}" });
    expect(resolveMcpUrl(s, { MCP_AMAP_KEY: "k1" })).toBe(
      "https://mcp.amap.test/sse?key=k1",
    );
    expect(() => resolveMcpUrl(s, {})).toThrow(/MCP_AMAP_KEY/);
  });
});

describe("mcpToolMode", () => {
  it("decides tool modes in spec order", () => {
    const ro = { name: "search", annotations: { readOnlyHint: true } };
    const rw = { name: "create_page" };
    const s = server({
      approvalPolicy: "writes",
      requireApproval: [],
      autoApprove: ["create_page"],
      disabledTools: [],
    });
    expect(mcpToolMode(s, ro)).toBe("auto");
    expect(mcpToolMode(s, rw)).toBe("auto"); // autoApprove beats policy
    expect(mcpToolMode({ ...s, autoApprove: [] }, rw)).toBe("approval");
    expect(mcpToolMode({ ...s, requireApproval: ["search"] }, ro)).toBe(
      "approval",
    );
    expect(
      mcpToolMode(
        { ...s, disabledTools: ["search"], requireApproval: ["search"] },
        ro,
      ),
    ).toBe("disabled");
    expect(mcpToolMode(server({ requireApproval: [] }), rw)).toBe("auto"); // legacy: no policy
  });
});

describe("mcpToolName", () => {
  it("sanitizes tool names and rejects ones over 64 characters", () => {
    expect(mcpToolName("atlassian", "jira.get-issue")).toBe(
      "atlassian__jira_get-issue",
    );
    expect(mcpToolName("s", "x".repeat(70))).toBeNull();
  });
});

describe("mcpConnector", () => {
  it("resolves env: header values from the environment at connect time", async () => {
    const { manager, registered } = fakeManager();
    const connect = mcpConnector(manager, { NOTION_TOKEN: "secret" });

    await connect(
      server({
        headers: {
          Authorization: "env:NOTION_TOKEN",
          "X-Static": "yes",
        },
      }),
    );

    expect(registered).toHaveLength(1);
    expect(
      registered[0]?.config.transport?.requestInit?.headers,
    ).toEqual({ Authorization: "secret", "X-Static": "yes" });
  });

  it("skips a server whose header env var is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { manager, registered } = fakeManager();
    const connect = mcpConnector(manager, {});

    try {
      await expect(
        connect(server({ headers: { Authorization: "env:MISSING_TOKEN" } })),
      ).rejects.toThrow("MISSING_TOKEN");
      expect(registered).toHaveLength(0);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("skips the server through loadMcpTools when its secret is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { manager } = fakeManager();
    const connect = mcpConnector(manager, {});

    try {
      const { tools } = await loadMcpTools(
        [server({ headers: { Authorization: "env:MISSING_TOKEN" } })],
        gate("approved"),
        connect,
        recorder().emit,
      );
      expect(tools).toEqual([]);
      expect(error.mock.calls[0]?.[0]).toContain("MISSING_TOKEN");
    } finally {
      error.mockRestore();
    }
  });
  it("resolves URL placeholders when registering", async () => {
    const { manager, registered } = fakeManager();
    const connect = mcpConnector(manager, { MCP_AMAP_KEY: "k1" });

    await connect(
      server({ url: "https://mcp.amap.test/sse?key={env:MCP_AMAP_KEY}" }),
    );

    expect(registered[0]?.config.url).toBe(
      "https://mcp.amap.test/sse?key=k1",
    );
  });

  it("adds the Bearer token for an OAuth server", async () => {
    const { manager, registered } = fakeManager();
    const connect = mcpConnector(manager, {}, async () => "tok");

    await connect(server({ oauth: true, headers: { "X-Static": "yes" } }));

    expect(
      registered[0]?.config.transport?.requestInit?.headers,
    ).toEqual({ "X-Static": "yes", Authorization: "Bearer tok" });
  });

  it("refuses to connect an OAuth server without a token", async () => {
    const { manager, registered } = fakeManager();
    const connect = mcpConnector(manager, {}, async () => null);

    await expect(connect(server({ oauth: true }))).rejects.toThrow(
      "需要在桌面端登录授权",
    );
    expect(registered).toHaveLength(0);
  });

  it("passes tool annotations through listTools", async () => {
    const { manager } = fakeManager([
      { name: "search", annotations: { readOnlyHint: true } },
    ]);
    const client = await mcpConnector(manager)(server());

    await expect(client.listTools()).resolves.toEqual([
      {
        name: "search",
        description: undefined,
        inputSchema: undefined,
        annotations: { readOnlyHint: true },
      },
    ]);
  });
});

describe("loadMcpTools", () => {
  it("namespaces tools per server and wraps the approval-listed ones", async () => {
    const calls: string[] = [];
    const client = fakeClient(calls);
    const approval = gate("rejected");
    const connect: McpConnector = async () => client;
    const progress = recorder();

    const { tools } = await loadMcpTools(
      [server()],
      approval,
      connect,
      progress.emit,
    );

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
      { type: "progress", text: "MCP notion：create_page ✓" },
      { type: "progress", text: "MCP notion：search" },
      { type: "progress", text: "MCP notion：search ✓" },
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

    const { tools } = await loadMcpTools(
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

    const { tools } = await loadMcpTools(
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

    const { tools } = await loadMcpTools(
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
    const { tools } = await loadMcpTools(
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
    ).resolves.toEqual({ tools: [], unavailable: [] });
    expect(connect).not.toHaveBeenCalled();
  });

  it("skips enabled:false servers and disabled tools", async () => {
    const connect = vi.fn(async () => fakeClient([]));

    const loaded = await loadMcpTools(
      [
        server({ name: "off", url: "https://off.test", enabled: false }),
        server({ disabledTools: ["search"] }),
      ],
      gate("approved"),
      connect,
      recorder().emit,
    );

    expect(loaded.tools.map((tool) => tool.name)).toEqual([
      "notion__create_page",
    ]);
    expect(loaded.unavailable).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("connects servers concurrently and reports a timed-out one as unavailable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const connect: McpConnector = (server) =>
      server.name === "slow"
        ? new Promise<McpClientLike>(() => {})
        : new Promise((resolve) =>
            setTimeout(() => resolve(fakeClient([])), 80),
          );

    try {
      const started = Date.now();
      const loaded = await loadMcpTools(
        [server({ name: "slow", url: "https://slow.test" }), server()],
        gate("approved"),
        connect,
        recorder().emit,
        100,
      );
      const elapsed = Date.now() - started;

      // Sequentially the good server would finish only after the slow timeout.
      expect(elapsed).toBeLessThan(150);
      expect(loaded.tools.map((tool) => tool.name)).toEqual([
        "notion__create_page",
        "notion__search",
      ]);
      expect(loaded.unavailable).toEqual([
        { name: "slow", reason: expect.stringMatching(/timed out/) },
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it("reports an unauthorized OAuth server as unavailable without connecting", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { manager, registered } = fakeManager();
    const connect = mcpConnector(manager, {}, async () => null);

    try {
      const loaded = await loadMcpTools(
        [server({ oauth: true })],
        gate("approved"),
        connect,
        recorder().emit,
      );

      expect(loaded.tools).toEqual([]);
      expect(loaded.unavailable).toEqual([
        { name: "notion", reason: "需要在桌面端登录授权" },
      ]);
      expect(registered).toHaveLength(0);
    } finally {
      error.mockRestore();
    }
  });

  it("skips a tool whose sanitized name collides with an earlier one or is too long", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client: McpClientLike = {
      async listTools() {
        return [
          { name: "a.b" },
          { name: "a_b" },
          { name: "x".repeat(70) },
          { name: "c" },
        ];
      },
      async callTool() {
        return { content: [] };
      },
    };

    try {
      const loaded = await loadMcpTools(
        [server({ name: "s", requireApproval: [] })],
        gate("approved"),
        async () => client,
        recorder().emit,
      );

      expect(loaded.tools.map((tool) => tool.name)).toEqual(["s__a_b", "s__c"]);
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });
});

describe("probeMcpServer", () => {
  it("returns tools with modes, or the failure reason", async () => {
    const client: McpClientLike = {
      async listTools() {
        return [
          {
            name: "search",
            description: "Search",
            annotations: { readOnlyHint: true },
          },
          { name: "create_page" },
        ];
      },
      async callTool() {
        return { content: [] };
      },
    };

    await expect(
      probeMcpServer(
        server({ approvalPolicy: "writes", requireApproval: [] }),
        async () => client,
      ),
    ).resolves.toEqual({
      ok: true,
      tools: [
        { name: "search", description: "Search", mode: "auto" },
        { name: "create_page", description: "", mode: "approval" },
      ],
    });

    const failing: McpConnector = async () => {
      throw new Error("connection refused");
    };
    await expect(probeMcpServer(server(), failing)).resolves.toEqual({
      ok: false,
      reason: "connection refused",
    });
  });
});

describe("unavailableNotice", () => {
  it("formats the unavailable notice", () => {
    expect(unavailableNotice([])).toBeUndefined();
    expect(
      unavailableNotice([
        { name: "a", reason: "x" },
        { name: "b", reason: "y" },
      ]),
    ).toBe("以下服务本次不可用：a（x）；b（y）");
  });
});
