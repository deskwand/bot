import { create } from "zustand";
import type { Page } from "@/components/app-context";

// Cross-page, non-sensitive UI state only. Deployment authority stays in Go and
// Cloudflare; credentials and secret values never enter this store.
interface UiState {
  page: Page;
  setPage: (page: Page) => void;
}

export const useUiStore = create<UiState>((set) => ({
  page: "overview",
  setPage: (page) => set({ page }),
}));
