import type { Messages } from "../messages";

export const mcp: Messages["mcp"] = {
  MCP_SERVER_NOT_FOUND: "Service not found",
  MCP_SERVER_NOT_FOUND_OR_NO_AUTH:
    "Service not found or does not need authorization",
  MCP_DCR_UNSUPPORTED:
    "This service does not support automatic registration (DCR)",
  MCP_AUTH_REQUIRED: "Sign in from the desktop app to authorize",
  reauthNotice:
    "🔑 {name} authorization expired; sign in again in the desktop app",
  callbackSuccess:
    "Authorization complete. You can return to the desktop app.",
  callbackFailure:
    "Authorization failed. Return to the desktop app and try again.",
};
