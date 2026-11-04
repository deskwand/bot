import type { CustomProviderDTO, ModelCatalogDTO, ModelDTO } from "@/services/types";

export type ProviderOption = {
  id: string;
  label: string;
  custom: boolean;
  keyless: boolean;
  models: { id: string; label: string; imageInput: boolean }[];
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
