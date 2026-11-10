export const SEARCH_PROVIDER_IDS = [
  "exa",
  "tavily",
  "brave",
  "deepseek",
] as const;

export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

export type SearchResult = { title: string; url: string; snippet: string };

export interface SearchAdapter {
  id: SearchProviderId;
  label: string; // 回落说明里用：Exa / Tavily / Brave / DeepSeek
  search(
    query: string,
    max: number,
    signal: AbortSignal,
  ): Promise<SearchResult[]>;
}
