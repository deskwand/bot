import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type Models,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Api, AuthContext, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { PiModel } from "agents/harness/pi";
import { ownerLocale } from "../i18n";
import { lifeStub } from "../life/client";
import { meteredProvider, type Meter } from "../life/meter";
import { readRuntimeConfig, RuntimeConfigError } from "../runtime-config";
import { BUILTIN_PROVIDERS } from "./catalog.generated";
import { modelKeyAuth } from "./model-key-auth";
import { defaultLevelFrom } from "./thinking-level";
import {
  modelKeyMissingText,
  modelUnavailableText,
  workersAiBindingUnavailableText,
} from "./model-errors";
import {
  MODEL_KEY_PREFIX,
  secretNameFor,
  type CustomProviderConfig,
} from "./providers";
import {
  WORKERS_AI_PROVIDER_ID,
  workersAiBindingReady,
  workersAiProvider,
} from "./workers-ai";

export type Role = "butler" | "task";

/**
 * One role's model, as the deployment configuration stores it. `thinkingLevel`
 * rides along because the desktop edits the whole object at once; absent means
 * the model's default level (see `defaultThinkingLevel`).
 */
export type ModelRef = {
  provider: string;
  id: string;
  thinkingLevel?: ModelThinkingLevel;
};

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
 * The level a model nobody configured uses. Undefined when the model is not in
 * the collection, which leaves whatever the conversation already stored.
 */
export function defaultThinkingLevel(
  model: Model<Api> | undefined,
): ModelThinkingLevel | undefined {
  if (model === undefined) return undefined;
  return defaultLevelFrom(getSupportedThinkingLevels(model));
}

/**
 * Builds the pi-ai model catalog for a Worker environment. Every provider
 * resolves its API key through the read-only `MODEL_KEY_<ID>` secrets; the
 * default pi-ai auth context reads `process.env`, which Workers does not
 * populate from bindings.
 */
export function createModelsForEnv(env: Env, meter?: Meter): MutableModels {
  const authContext: AuthContext = {
    async env(name) {
      if (!name.startsWith(MODEL_KEY_PREFIX)) return undefined;
      const value = (env as unknown as Record<string, unknown>)[name];
      return typeof value === "string" && value.trim() ? value : undefined;
    },
    async fileExists() {
      return false;
    },
  };

  const models = createModels({ authContext });
  const register = (provider: Provider): void => {
    models.setProvider(
      meter
        ? meteredProvider(provider, meter, (entry) =>
            lifeStub(env).recordSpend(entry),
          )
        : provider,
    );
  };
  for (const { create } of BUILTIN_PROVIDERS) {
    const provider = create();
    register(
      Object.create(provider, {
        auth: {
          value: {
            apiKey: modelKeyAuth(
              provider.name + " API key",
              secretNameFor(provider.id),
            ),
          },
          enumerable: true,
        },
      }) as Provider,
    );
  }

  for (const config of readCustomProviders(env)) {
    register(customProvider(config));
  }
  for (const provider of testProviders.values()) register(provider);
  if (workersAiBindingReady(env)) register(workersAiProvider(env));
  return models;
}

/**
 * Reports why a model cannot run, or `undefined` when it can. Test overrides
 * and scripted test providers bypass the check.
 */
export function modelReadiness(
  env: Env,
  models: Models,
  ref: ModelRef,
): string | undefined {
  if (modelOverride || testProviders.has(ref.provider)) return undefined;

  const locale = ownerLocale(env);
  const workersAi = ref.provider === WORKERS_AI_PROVIDER_ID;
  if (workersAi && !workersAiBindingReady(env)) {
    return workersAiBindingUnavailableText(locale);
  }

  if (!models.getModel(ref.provider, ref.id)) {
    return modelUnavailableText(locale, ref.provider, ref.id);
  }

  if (workersAi) return undefined;

  const secretName = secretNameFor(ref.provider);
  const key = (env as unknown as Record<string, string | undefined>)[secretName];
  if (!key?.trim()) {
    return modelKeyMissingText(locale, ref.provider, secretName);
  }

  return undefined;
}

/**
 * Whether the configured model can take images; test overrides and scripted
 * providers say yes, matching `modelReadiness`'s bypass. pi-ai replaces images
 * with a placeholder for models whose `input` lacks `"image"`.
 */
export function modelAcceptsImages(models: Models, ref: ModelRef): boolean {
  if (modelOverride || testProviders.has(ref.provider)) return true;
  return models.getModel(ref.provider, ref.id)?.input.includes("image") ?? false;
}

function readCustomProviders(env: Env): CustomProviderConfig[] {
  try {
    return readRuntimeConfig(env).models.customProviders ?? [];
  } catch (error) {
    if (error instanceof RuntimeConfigError) return [];
    throw error;
  }
}

function customProvider(config: CustomProviderConfig): Provider {
  const name = config.name ?? config.id;
  return createProvider({
    id: config.id,
    name,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: modelKeyAuth(`${name} API key`, secretNameFor(config.id)),
    },
    api:
      config.api === "anthropic-messages"
        ? anthropicMessagesApi()
        : openAICompletionsApi(),
    models: config.models.map((model) => ({
      id: model.id,
      name: model.id,
      api: config.api,
      provider: config.id,
      baseUrl: config.baseUrl,
      input: ["text"],
      reasoning: false,
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cacheRead: model.cost?.cacheRead ?? 0,
        cacheWrite: model.cost?.cacheWrite ?? 0,
      },
      contextWindow: model.contextWindow ?? 128000,
      maxTokens: model.maxTokens ?? 8192,
    })),
  });
}
