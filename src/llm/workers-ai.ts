import {
  lazyStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type FetchFunction,
  type Model,
  type ProviderStreams,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAiBindingFetch,
  type AiBinding,
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  createProvider,
  type Provider,
} from "@earendil-works/pi-ai/models";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";

import {
  isWorkersAiPaidPlanRequired,
  isWorkersAiQuotaExhausted,
  WORKERS_AI_PAID_PLAN_MARKER,
  WORKERS_AI_QUOTA_MARKER,
} from "./model-errors";

export const WORKERS_AI_PROVIDER_ID = "workers-ai";

/**
 * Binding passthrough for the gateway's Workers AI provider. pi appends
 * `/chat/completions`, so this stops at the version segment.
 */
export const WORKERS_AI_BASE_URL =
  "https://workers-binding.ai/ai-gateway/gateways/default/workers-ai/v1";

/**
 * Binding calls are pre-authenticated in-account. The sentinel satisfies the
 * SDK's auth-header check, while the nulls drop the placeholder auth headers
 * the SDK would otherwise send — the gateway treats a request-supplied auth
 * header as a BYOK key.
 */
const BINDING_AUTH_HEADERS = {
  "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
  Authorization: null,
  "x-api-key": null,
};

export function workersAiBindingReady(env: Env): boolean {
  return (
    typeof (env.AI as { fetch?: unknown } | undefined)?.fetch === "function"
  );
}

/** Callers must check `workersAiBindingReady` first. */
export function workersAiProvider(env: Env): Provider {
  const inner = openAICompletionsApi();
  const bindingFetch: FetchFunction = createAiBindingFetch(
    env.AI as unknown as AiBinding,
  );

  const api: ProviderStreams = {
    stream: (model, context, options) =>
      rewriteErrorMessages(
        model,
        inner.stream(model, context, withBinding(bindingFetch, options)),
      ),
    streamSimple: (model, context, options) =>
      rewriteErrorMessages(
        model,
        inner.streamSimple(model, context, withBinding(bindingFetch, options)),
      ),
  };

  return createProvider({
    id: WORKERS_AI_PROVIDER_ID,
    name: "Cloudflare Workers AI",
    baseUrl: WORKERS_AI_BASE_URL,
    auth: {
      apiKey: {
        name: "Cloudflare AI binding",
        async resolve() {
          return {
            auth: { apiKey: CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL },
            source: "AI binding",
          };
        },
      },
    },
    api,
    models: Object.values(CLOUDFLARE_WORKERS_AI_MODELS)
      .filter((model) => model.api === "openai-completions")
      .map((model) => ({
        ...model,
        provider: WORKERS_AI_PROVIDER_ID,
        baseUrl: WORKERS_AI_BASE_URL,
      })),
  });
}

/** Caller headers stay first so the binding auth values always win. */
function withBinding(
  fetch: FetchFunction,
  options: StreamOptions | undefined,
): StreamOptions {
  return {
    ...options,
    fetch,
    headers: { ...options?.headers, ...BINDING_AUTH_HEADERS },
  };
}

/**
 * Pass partial updates through untouched and rewrite only the final message.
 * The quota marker must not look retryable, or pi would back off and retry a
 * failure that cannot recover before the free allowance resets.
 */
function rewriteErrorMessages(
  model: Model<Api>,
  inner: AssistantMessageEventStream,
): AssistantMessageEventStream {
  return lazyStream(model, async () => rewriteEvents(inner));
}

async function* rewriteEvents(
  inner: AssistantMessageEventStream,
): AsyncGenerator<AssistantMessageEvent> {
  for await (const event of inner) {
    if (event.type === "error") {
      yield { ...event, error: rewriteErrorMessage(event.error) };
    } else if (event.type === "done") {
      yield { ...event, message: rewriteErrorMessage(event.message) };
    } else {
      yield event;
    }
  }
}

function rewriteErrorMessage(message: AssistantMessage): AssistantMessage {
  if (message.stopReason !== "error" || !message.errorMessage) return message;
  if (isWorkersAiQuotaExhausted(message.errorMessage)) {
    return { ...message, errorMessage: WORKERS_AI_QUOTA_MARKER };
  }
  if (isWorkersAiPaidPlanRequired(message.errorMessage)) {
    return { ...message, errorMessage: WORKERS_AI_PAID_PLAN_MARKER };
  }
  return message;
}
