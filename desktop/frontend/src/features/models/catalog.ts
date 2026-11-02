import type { ModelDTO } from "@/services/types";

export const PROVIDERS: { id: string; label: string; secretName: string; models: string[] }[] = [
  {
    id: "opencode-go",
    label: "OpenCode Go",
    secretName: "OPENCODE_API_KEY",
    models: [
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "glm-5.3",
      "kimi-k3",
      "qwen3.8-max",
      "gpt-5.6-luna",
      "grok-4.7",
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    secretName: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-5-5", "claude-haiku-5-5"],
  },
];

export const DEFAULT_MODEL: ModelDTO = {
  provider: "opencode-go",
  id: "deepseek-v4.1-flash",
};

export function providerLabel(provider: string): string {
  return PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider;
}

export function secretNameForProvider(provider: string): string {
  return PROVIDERS.find((entry) => entry.id === provider)?.secretName ?? "";
}

export function allModels(): { provider: string; id: string; label: string }[] {
  return PROVIDERS.flatMap((provider) =>
    provider.models.map((id) => ({
      provider: provider.id,
      id,
      label: `${provider.label} · ${id}`,
    })),
  );
}

export function modelKey(model: ModelDTO | null): string {
  return model ? `${model.provider}/${model.id}` : "";
}

export function parseModelKey(value: string): ModelDTO | null {
  const [provider, id] = value.split("/");
  if (!provider || !id) return null;
  return { provider, id };
}

export function parseUserIDs(value: string): number[] {
  return value
    .split(/[\s,，]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}
