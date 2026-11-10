export type SearchProviderOption = {
  id: "exa" | "tavily" | "brave" | "deepseek";
  /** Secret holding the provider key; Exa needs none. */
  secret: string | null;
  signupUrl: string | null;
};

export const SEARCH_PROVIDERS: readonly SearchProviderOption[] = [
  { id: "exa", secret: null, signupUrl: null },
  {
    id: "tavily",
    secret: "SEARCH_KEY_TAVILY",
    signupUrl: "https://app.tavily.com",
  },
  {
    id: "brave",
    secret: "SEARCH_KEY_BRAVE",
    signupUrl: "https://api-dashboard.search.brave.com",
  },
  {
    id: "deepseek",
    secret: "MODEL_KEY_DEEPSEEK",
    signupUrl: "https://platform.deepseek.com",
  },
];
