import { t, type Locale } from "../i18n";
import type { McpUserErrorCode } from "./errors";

export function mcpErrorText(
  locale: Locale,
  code: McpUserErrorCode,
): string {
  return t(locale, `mcp.${code}`);
}

export function mcpAuthRequiredText(locale: Locale): string {
  return t(locale, "mcp.MCP_AUTH_REQUIRED");
}

export function mcpReauthNotice(locale: Locale, name: string): string {
  return t(locale, "mcp.reauthNotice", { name });
}
