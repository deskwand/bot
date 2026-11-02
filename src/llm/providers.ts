import catalog from "../../contracts/model-catalog.json";
import type { ModelsConfig } from "../config";
import type { Role } from "./models";

export const MODEL_KEY_PREFIX = "MODEL_KEY_";

/** Secret name holding a provider's API key; one secret per provider id. */
export function secretNameFor(providerId: string): string {
  return MODEL_KEY_PREFIX + providerId.toUpperCase().replaceAll("-", "_");
}

export type CustomModelConfig = {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
};

export type CustomProviderConfig = {
  id: string;
  name?: string;
  api: "openai-completions" | "anthropic-messages";
  baseUrl: string;
  models: CustomModelConfig[];
};

/**
 * Built-in provider ids from the generated catalog. Keeping this a JSON import
 * avoids pulling every pi-ai provider module into configuration-only code.
 */
export const BUILTIN_PROVIDER_IDS: ReadonlySet<string> = new Set(
  catalog.providers.map((provider) => provider.id),
);

const ROLES: readonly Role[] = ["butler", "task"];

/**
 * Semantic checks the JSON schema cannot express: custom providers must not
 * shadow a built-in id, ids must be unique, and each role must reference a
 * built-in provider or a model declared by one of the custom providers.
 *
 * Built-in model ids are deliberately not checked here: a pi-ai upgrade may
 * drop one, and the runtime readiness check reports it for that role only
 * instead of invalidating the whole configuration.
 */
export function modelsConfigValid(models: ModelsConfig): boolean {
  const custom = new Map<string, CustomProviderConfig>();
  for (const provider of models.customProviders ?? []) {
    if (BUILTIN_PROVIDER_IDS.has(provider.id)) return false;
    if (custom.has(provider.id)) return false;
    const modelIds = new Set<string>();
    for (const model of provider.models) {
      if (modelIds.has(model.id)) return false;
      modelIds.add(model.id);
    }
    custom.set(provider.id, provider);
  }

  for (const role of ROLES) {
    const ref = models[role];
    if (BUILTIN_PROVIDER_IDS.has(ref.provider)) continue;
    const provider = custom.get(ref.provider);
    if (!provider) return false;
    if (!provider.models.some((model) => model.id === ref.id)) return false;
  }

  return true;
}
