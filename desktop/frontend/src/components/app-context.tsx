import { createContext, useContext } from "react";
import type { ClientService } from "@/services/types";

export type Page = "overview" | "models" | "entries" | "diagnostics" | "updates";

export const PAGE_LABELS: Record<Page, string> = {
  overview: "服务概览",
  models: "模型",
  entries: "消息入口",
  diagnostics: "诊断",
  updates: "更新",
};

export interface AppContextValue {
  client: ClientService;
  navigate: (page: Page) => void;
  setDirty: (dirty: boolean) => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("AppContext is missing");
  return value;
}
