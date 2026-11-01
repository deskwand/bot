import { createModels, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { AuthContext } from "@earendil-works/pi-ai";
import type { PiModel } from "agents/harness/pi";

export type Role = "butler" | "task";

export type ModelRef = { provider: "anthropic" | "opencode-go"; id: string };

/**
 * Test-only model override. When set, `resolveModel` returns it regardless of
 * the requested role. The scripted provider that backs the model is registered
 * through `registerTestProvider`.
 */
let modelOverride: PiModel | null = null;

/** Providers registered by tests, added to every `Models` collection built here. */
const testProviders = new Map<string, Provider>();

export function setModelOverride(model: PiModel | null): void {
  modelOverride = model;
}

/** Test-only: make `provider` available to the `Models` a Durable Object builds. */
export function registerTestProvider(provider: Provider): void {
  testProviders.set(provider.id, provider);
}

export function resolveModel(ref: ModelRef, _env: Env): PiModel {
  // Pi only stores and resolves the `provider`/`id` pair; the model is looked
  // up again in the `Models` collection the harness was opened with.
  return modelOverride ?? ref;
}

/**
 * Builds the pi-ai model catalog for a Worker environment. Providers resolve
 * their API keys (`OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`) through this auth
 * context, because the default pi-ai auth context reads `process.env`, which
 * Workers does not populate from bindings.
 */
export function createModelsForEnv(env: Env): MutableModels {
  const authContext: AuthContext = {
    async env(name) {
      const value = (env as unknown as Record<string, unknown>)[name];
      return typeof value === "string" ? value : undefined;
    },
    async fileExists() {
      return false;
    },
  };

  const models = createModels({ authContext });
  models.setProvider(opencodeGoProvider());
  models.setProvider(anthropicProvider());
  for (const provider of testProviders.values()) models.setProvider(provider);
  return models;
}
