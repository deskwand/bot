import type { SearchAdapter } from "./types";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "bot-web-search", version: "1.0.0" };

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
};

type JsonRpcContent = {
  type?: string;
  text?: string;
};

type JsonRpcResult = {
  content?: JsonRpcContent[];
  isError?: boolean;
  [key: string]: unknown;
};

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id?: number | string | null;
  result?: JsonRpcResult;
  error?: { code: number; message: string; data?: unknown };
};

let nextId = 1;

function parseSseMessages(body: string): unknown[] {
  const events: string[] = [];
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length > 0) {
      events.push(dataLines.join("\n"));
      dataLines = [];
    }
  };

  for (const line of body.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();

  return events.map((event) => JSON.parse(event) as unknown);
}

async function parseRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const raw = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const trimmed = raw.trimStart();
  const isSse =
    contentType.includes("text/event-stream") ||
    trimmed.startsWith("event:") ||
    trimmed.startsWith("data:");

  if (isSse) {
    let messages: JsonRpcResponse[];
    try {
      messages = parseSseMessages(raw) as JsonRpcResponse[];
    } catch {
      throw new Error("Exa MCP 返回了无效的 SSE 数据");
    }
    const message = [...messages]
      .reverse()
      .find((item) => item.result !== undefined || item.error !== undefined);
    if (!message) throw new Error("Exa MCP 返回了空的 SSE 响应");
    return message;
  }

  try {
    return JSON.parse(raw) as JsonRpcResponse;
  } catch {
    throw new Error("Exa MCP 返回了无效的 JSON");
  }
}

async function mcpPost(
  fetchImpl: typeof fetch,
  request: JsonRpcRequest,
  sessionId: string | undefined,
  signal: AbortSignal,
): Promise<{ json: JsonRpcResponse; sessionId: string | undefined }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const response = await fetchImpl(EXA_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Exa MCP 返回 HTTP ${response.status}`);
  }

  const nextSessionId =
    response.headers.get("mcp-session-id") ?? sessionId ?? undefined;
  const json = await parseRpcResponse(response);
  if (json.error) {
    throw new Error(
      json.error.message || `Exa MCP JSON-RPC 错误 ${json.error.code}`,
    );
  }
  return { json, sessionId: nextSessionId };
}

async function mcpNotify(
  fetchImpl: typeof fetch,
  method: string,
  params: unknown,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetchImpl(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Exa MCP 返回 HTTP ${response.status}`);
  }
}

function resultText(result: JsonRpcResult | undefined): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item?.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

/**
 * Search the web through Exa's keyless hosted MCP endpoint. The endpoint uses
 * MCP Streamable HTTP, so each search opens a session (initialize →
 * notifications/initialized → tools/call) and reuses its Mcp-Session-Id.
 */
export function exaAdapter(fetchImpl: typeof fetch): SearchAdapter {
  return {
    id: "exa",
    label: "Exa",
    async search(query, max, signal) {
      const initialize = await mcpPost(
        fetchImpl,
        {
          jsonrpc: "2.0",
          id: nextId++,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          },
        },
        undefined,
        signal,
      );

      const sessionId = initialize.sessionId;
      if (sessionId) {
        await mcpNotify(
          fetchImpl,
          "notifications/initialized",
          {},
          sessionId,
          signal,
        );
      }

      const call = await mcpPost(
        fetchImpl,
        {
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: {
            name: "web_search_exa",
            arguments: { query, numResults: max },
          },
        },
        sessionId,
        signal,
      );

      const text = resultText(call.json.result);
      if (call.json.result?.isError) {
        throw new Error(text || "Exa 返回错误");
      }
      return text ? [{ title: "", url: "", snippet: text }] : [];
    },
  };
}
