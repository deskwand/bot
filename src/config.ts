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

export const config: AppConfig = {
  owner: {
    // Fill in the Telegram user IDs allowed to use the bot.
    telegramUserIds: [],
  },
  models: {
    butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  },
  mcpServers: [],
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
