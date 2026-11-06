/**
 * Failures a person can act on. The code crosses Durable Object RPC, where a
 * custom error class does not survive, so each error's message is the code.
 */
export type McpUserErrorCode =
  | "MCP_SERVER_NOT_FOUND"
  | "MCP_SERVER_NOT_FOUND_OR_NO_AUTH"
  | "MCP_DCR_UNSUPPORTED"
  | "MCP_AUTH_REQUIRED";

const CODES = new Set<string>([
  "MCP_SERVER_NOT_FOUND",
  "MCP_SERVER_NOT_FOUND_OR_NO_AUTH",
  "MCP_DCR_UNSUPPORTED",
  "MCP_AUTH_REQUIRED",
] satisfies McpUserErrorCode[]);

export class McpUserError extends Error {
  constructor(readonly code: McpUserErrorCode) {
    super(code);
    this.name = "McpUserError";
  }
}

/** Reads the code from a direct error or one rebuilt by Durable Object RPC. */
export function mcpUserErrorCode(error: unknown): McpUserErrorCode | null {
  if (error instanceof McpUserError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return CODES.has(message) ? (message as McpUserErrorCode) : null;
}
