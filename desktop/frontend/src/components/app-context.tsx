import { createContext, useContext } from "react";
import { tryT } from "@/i18n";
import type { ClientService } from "@/services/types";

export type Page = "overview" | "models" | "bots" | "search" | "exchange" | "agent" | "mcp" | "entries" | "cloudflare" | "server" | "diagnostics" | "backup" | "updates";

export function pageLabel(page: Page): string {
  return tryT(`shell.pages.${page}`) ?? page;
}

export function pageSubtitle(page: Page): string {
  return tryT(`shell.subtitles.${page}`) ?? "";
}

export interface AppContextValue {
  client: ClientService;
  targetKind: string;
  refresh: (showLoading?: boolean) => Promise<void>;
  navigate: (page: Page) => void;
  navigateImport: () => void;
  setDirty: (dirty: boolean) => void;
  signedOut: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("AppContext is missing");
  return value;
}
