import type { Api, Model, StreamFunction, Usage } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { SpendEntry } from "./books";
import { WORKERS_AI_PROVIDER_ID } from "../llm/workers-ai";

export type Meter = {
  /** Read when the call ends, so a TaskDO can name its current task. */
  source(): string;
  waitUntil(promise: Promise<unknown>): void;
};

export type Rates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** What one finished call cost. `usage.cost.total` is pi-ai's own figure. */
export function spendUsd(
  provider: string,
  usage: Usage,
  rates: Rates,
): { usd: number; priced: boolean } {
  if (provider === WORKERS_AI_PROVIDER_ID) return { usd: 0, priced: true };
  if (usage.totalTokens === 0) return { usd: 0, priced: false };
  if (
    rates.input === 0 &&
    rates.output === 0 &&
    rates.cacheRead === 0 &&
    rates.cacheWrite === 0
  ) {
    return { usd: 0, priced: false };
  }
  return { usd: usage.cost.total, priced: true };
}

/** A provider whose stream/streamSimple hand usage to `report` once the stream settles. */
export function meteredProvider(
  provider: Provider,
  meter: Meter,
  report: (entry: SpendEntry) => Promise<void>,
): Provider {
  const metered =
    (inner: StreamFunction): StreamFunction =>
    (model: Model<Api>, context, options) => {
      const stream = inner(model, context, options);
      const callId = crypto.randomUUID();
      meter.waitUntil(
        stream
          .result()
          .then(async (message) => {
            if (
              (message.stopReason === "error" ||
                message.stopReason === "aborted") &&
              message.usage.totalTokens === 0
            ) {
              return;
            }
            const { usd, priced } = spendUsd(
              provider.id,
              message.usage,
              model.cost,
            );
            await report({
              callId,
              at: Date.now(),
              source: meter.source(),
              provider: provider.id,
              model: message.model,
              inputTokens: message.usage.input,
              outputTokens: message.usage.output,
              cacheReadTokens: message.usage.cacheRead,
              cacheWriteTokens: message.usage.cacheWrite,
              usd,
              priced,
            });
          })
          .catch((error) => {
            console.warn("life: model call was not metered", error);
          }),
      );
      return stream;
    };

  return Object.create(provider, {
    stream: { value: metered(provider.stream), enumerable: true },
    streamSimple: { value: metered(provider.streamSimple), enumerable: true },
  }) as Provider;
}
