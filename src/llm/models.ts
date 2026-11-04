import {
  createModels,
  createProvider,
  type Models,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { AuthContext } from "@earendil-works/pi-ai";
import type { PiModel } from "agents/harness/pi";
import { readRuntimeConfig, RuntimeConfigError } from "../runtime-config";
import { BUILTIN_PROVIDERS } from "./catalog.generated";
import { modelKeyAuth } from "./model-key-auth";
import {
  MODEL_KEY_PREFIX,
  secretNameFor,
  type CustomProviderConfig,
} from "./providers";
import {
  WORKERS_AI_BINDING_UNAVAILABLE_TEXT,
  WORKERS_AI_PROVIDER_ID,
  workersAiBindingReady,
  workersAiProvider,
} from "./workers-ai";

export type Role = "butler" | "task";

export type ModelRef = { provider: string; id: string };

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
 * Builds the pi-ai model catalog for a Worker environment. Every provider
 * resolves its API key through the read-only `MODEL_KEY_<ID>` secrets; the
 * default pi-ai auth context reads `process.env`, which Workers does not
 * populate from bindings.
 */
export function createModelsForEnv(env: Env): MutableModels {
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
  for (const { create } of BUILTIN_PROVIDERS) {
    const provider = create();
    models.setProvider(
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
    models.setProvider(customProvider(config));
  }
  for (const provider of testProviders.values()) models.setProvider(provider);
  if (workersAiBindingReady(env)) models.setProvider(workersAiProvider(env));
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

  const workersAi = ref.provider === WORKERS_AI_PROVIDER_ID;
  if (workersAi && !workersAiBindingReady(env)) {
    return WORKERS_AI_BINDING_UNAVAILABLE_TEXT;
  }

  if (!models.getModel(ref.provider, ref.id)) {
    return `模型 ${ref.provider}/${ref.id} 不可用，请在桌面端模型页重新选择`;
  }

  if (workersAi) return undefined;

  const secretName = secretNameFor(ref.provider);
  const key = (env as unknown as Record<string, string | undefined>)[secretName];
  if (!key?.trim()) {
    return `模型 ${ref.provider} 没有配置 key（${secretName}），请在桌面端模型页填写`;
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
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? 128000,
      maxTokens: model.maxTokens ?? 8192,
    })),
  });
}
