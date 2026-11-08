import type { CustomProviderDTO, ModelCatalogDTO, ModelDTO } from "@/services/types";

export type ProviderOption = {
  id: string;
  label: string;
  custom: boolean;
  keyless: boolean;
  models: { id: string; label: string; imageInput: boolean; thinkingLevels?: string[] }[];
};

export const DEFAULT_MODEL: ModelDTO = {
  provider: "workers-ai",
  id: "@cf/google/gemma-4-26b-a4b-it",
};

export function secretNameFor(id: string): string {
  return `MODEL_KEY_${id.toUpperCase().replaceAll("-", "_")}`;
}

export function providerNeedsKey(catalog: ModelCatalogDTO, providerId: string): boolean {
  const provider = catalog.providers.find((entry) => entry.id === providerId);
  return !(provider?.keyless === true);
}

export function providerOptions(
  catalog: ModelCatalogDTO,
  custom: CustomProviderDTO[],
): ProviderOption[] {
  const builtin = catalog.providers.map((provider) => ({
    id: provider.id,
    label: provider.name,
    custom: false,
    keyless: provider.keyless === true,
    models: provider.models.map((model) => ({
      id: model.id,
      label: model.name,
      imageInput: model.input?.includes("image") ?? false,
      thinkingLevels: model.thinkingLevels,
    })),
  }));
  const customOptions = custom.map((provider) => ({
    id: provider.id,
    label: provider.name?.trim() || provider.id,
    custom: true,
    keyless: false,
    models: provider.models.map((model) => ({
      id: model.id,
      label: model.id,
      imageInput: false,
    })),
  }));
  return [...builtin, ...customOptions];
}

export function modelKey(model: ModelDTO | null): string {
  return model ? `${model.provider}/${model.id}` : "";
}

/** Every level pi knows, in its own order; must match the schema enum. */
const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The levels to offer for the model behind `key`, in pi's order (lowest
 * first). A custom endpoint declares no capability map, and pi treats its
 * models as non-reasoning, so it offers only "off" — as does a model the
 * catalog does not list.
 */
export function thinkingLevelsFor(options: ProviderOption[], key: string): string[] {
  const model = parseModelKey(key);
  if (!model) return ["off"];
  const provider = options.find((entry) => entry.id === model.provider);
  const entry = provider?.models.find((item) => item.id === model.id);
  return entry?.thinkingLevels ?? ["off"];
}

/**
 * The closest level `levels` offers to `level`, mirroring pi's clamp: first a
 * supported level at or above the request, then below it. Switching models
 * therefore never turns thinking off behind the user's back.
 */
export function clampThinkingLevel(level: string, levels: string[]): string {
  if (levels.includes(level)) return level;
  const requested = THINKING_LEVEL_ORDER.indexOf(level);
  if (requested === -1) return levels[0] ?? "off";
  for (let index = requested; index < THINKING_LEVEL_ORDER.length; index += 1) {
    const candidate = THINKING_LEVEL_ORDER[index]!;
    if (levels.includes(candidate)) return candidate;
  }
  for (let index = requested - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVEL_ORDER[index]!;
    if (levels.includes(candidate)) return candidate;
  }
  return levels[0] ?? "off";
}

export function parseModelKey(value: string): ModelDTO | null {
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const provider = value.slice(0, slash);
  const id = value.slice(slash + 1);
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
