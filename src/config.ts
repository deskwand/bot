import type { CustomProviderConfig } from "./llm/providers";
import type { ModelRef, Role } from "./llm/models";
import type { Locale } from "./i18n";
import type { SearchProviderId } from "./tools/search/types";

export type McpServerConfig = {
  name: string;
  url: string;
  headers?: Record<string, string>;
  requireApproval?: string[];
  description?: string;
  catalogId?: string;
  oauth?: boolean;
  enabled?: boolean;
  approvalPolicy?: "writes";
  autoApprove?: string[];
  disabledTools?: string[];
};

export type ModelsConfig = Record<Role, ModelRef> & {
  frugal?: ModelRef;
  customProviders?: CustomProviderConfig[];
};

export type ApprovalMode = "autonomous" | "reviewed";

export type AppConfig = {
  owner: { telegramUserIds: number[] };
  models: ModelsConfig;
  mcpServers: McpServerConfig[];
  locale?: Locale;
  approvalMode?: ApprovalMode;
  /** Search provider for `web_search`; absent means `exa`. */
  search?: { provider?: SearchProviderId };
  /** Raw mail section; every field is validated in src/mail/accounts.ts. */
  email?: { accounts?: unknown[] };
  /** Raw exchange section; every field is validated in src/exchange/accounts.ts. */
  exchange?: { accounts?: unknown[] };
  /** Raw wallet section; every field is validated in src/wallet/config.ts. */
  wallet?: { rpcUrl?: unknown };
};

export function configLocale(cfg: AppConfig): Locale {
  return cfg.locale ?? "zh";
}

export function configApprovalMode(cfg: AppConfig): ApprovalMode {
  return cfg.approvalMode ?? "autonomous";
}

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
