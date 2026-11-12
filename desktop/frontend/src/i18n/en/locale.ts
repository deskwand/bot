import type { Messages } from "../types";

export const locale: Messages["locale"] = {
  label: "Language",
  system: "System",
  zh: "中文",
  en: "English",
  saveFailed: "Language setting was not saved; it will revert on next launch",
  pendingBot: "The bot switches to {lang} after the next publish",
  syncNow: "Sync now",
  syncing: "Syncing…",
  syncIncomplete: "Sync did not finish; continue it from Vitals.",
  syncBlockedDirty: "Publish or discard this page's changes first",
};
