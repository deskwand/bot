import type { ModelRef, Role } from "./llm/models";

export type McpServerConfig = {
  name: string;
  url: string;
  headers?: Record<string, string>;
  requireApproval?: string[];
};

export type AppConfig = {
  owner: { telegramUserIds: number[] };
  models: Record<Role, ModelRef>;
  mcpServers: McpServerConfig[];
};

export function isOwner(cfg: AppConfig, telegramUserId: number): boolean {
  return cfg.owner.telegramUserIds.includes(telegramUserId);
}

export function needsApproval(
  cfg: AppConfig,
  server: string,
  tool: string,
): boolean {
  const mcpServer = cfg.mcpServers.find((s) => s.name === server);
  return mcpServer?.requireApproval?.includes(tool) ?? false;
}
