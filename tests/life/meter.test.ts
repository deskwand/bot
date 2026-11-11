import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { describe, expect, it, vi } from "vitest";
import type { SpendEntry } from "../../src/life/books";
import {
  meteredProvider,
  spendUsd,
  type Meter,
  type Rates,
} from "../../src/life/meter";
import { WORKERS_AI_PROVIDER_ID } from "../../src/llm/workers-ai";

const rates: Rates = {
  input: 1,
  output: 2,
  cacheRead: 0.1,
  cacheWrite: 0.2,
};

const usage: Usage = {
  input: 100,
  output: 20,
  cacheRead: 10,
  cacheWrite: 5,
  totalTokens: 135,
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
};

const model: Model<"openai-completions"> = {
  id: "inner-model",
  name: "Inner Model",
  api: "openai-completions",
  provider: "inner",
  baseUrl: "http://localhost:0",
  input: ["text"],
  cost: rates,
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: false,
};

const context = { messages: [] } as unknown as TranscriptContext;

function message(
  answer: Usage,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "openai-completions",
    provider: "inner",
    model: "inner-model",
    usage: answer,
    stopReason,
    timestamp: 1,
  };
}

function streaming(answer: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial: AssistantMessage = {
    ...answer,
    content: [],
    stopReason: "pending",
  };
  stream.push({ type: "start", partial });
  if (answer.stopReason === "error" || answer.stopReason === "aborted") {
    stream.push({ type: "error", reason: answer.stopReason, error: answer });
  } else {
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: "hi",
      partial,
    });
    stream.push({
      type: "done",
      reason: answer.stopReason as "stop" | "length" | "toolUse" | "deferred",
      message: answer,
    });
  }
  stream.end(answer);
  return stream;
}

function provider(make: () => AssistantMessageEventStream): Provider {
  return createProvider({
    id: "inner",
    auth: {
      apiKey: { name: "Inner API key", resolve: async () => undefined },
    },
    models: [model],
    api: {
      stream: () => make(),
      streamSimple: () => make(),
    },
  }) as Provider;
}

async function collect(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function recorder(): {
  meter: Meter;
  entries: SpendEntry[];
  waits: Promise<unknown>[];
} {
  const entries: SpendEntry[] = [];
  const waits: Promise<unknown>[] = [];
  return {
    entries,
    waits,
    meter: {
      source: () => "test:source",
      waitUntil: (promise) => {
        waits.push(promise);
      },
    },
  };
}

describe("spendUsd", () => {
  it("treats Workers AI as fully paid", () => {
    expect(spendUsd(WORKERS_AI_PROVIDER_ID, usage, rates)).toEqual({
      usd: 0,
      priced: true,
    });
  });

  it("leaves a call without tokens unpriced", () => {
    expect(
      spendUsd("inner", { ...usage, totalTokens: 0 }, rates),
    ).toEqual({ usd: 0, priced: false });
  });

  it("leaves a call with zero rates unpriced", () => {
    expect(
      spendUsd(
        "inner",
        usage,
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ),
    ).toEqual({ usd: 0, priced: false });
  });

  it("uses pi-ai's own cost for a priced call", () => {
    expect(spendUsd("inner", usage, rates)).toEqual({
      usd: usage.cost.total,
      priced: true,
    });
  });
});

describe("meteredProvider", () => {
  it("reports one entry with the usage the stream settled on", async () => {
    const answer = message(usage);
    const { meter, entries, waits } = recorder();
    const metered = meteredProvider(provider(() => streaming(answer)), meter, async (entry) => {
      entries.push(entry);
    });

    const stream = metered.stream(model, context);
    await collect(stream);
    await Promise.all(waits);

    const result = await stream.result();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: "test:source",
      provider: "inner",
      model: "inner-model",
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheWriteTokens: result.usage.cacheWrite,
      usd: result.usage.cost.total,
      priced: true,
    });
    expect(entries[0]!.callId).toMatch(/[0-9a-f-]{36}/);
  });

  it("passes the inner stream's events through unchanged", async () => {
    const answer = message(usage);
    const { meter } = recorder();
    const inner = provider(() => streaming(message(usage)));
    const metered = meteredProvider(inner, meter, async () => {});

    const raw = await collect(inner.stream(model, context));
    const wrapped = await collect(metered.stream(model, context));

    expect(wrapped).toEqual(raw);
  });

  it("does not report an error that produced no tokens", async () => {
    const answer = message(
      { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      "error",
    );
    const { meter, entries, waits } = recorder();
    const metered = meteredProvider(provider(() => streaming(answer)), meter, async (entry) => {
      entries.push(entry);
    });

    await collect(metered.stream(model, context));
    await Promise.all(waits);

    expect(entries).toHaveLength(0);
  });

  it("lets the stream finish when reporting fails", async () => {
    const answer = message(usage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { meter, waits } = recorder();
    const metered = meteredProvider(provider(() => streaming(answer)), meter, async () => {
      throw new Error("life down");
    });

    const events = await collect(metered.stream(model, context));
    await Promise.all(waits);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_end",
      "done",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("meters streamSimple too, with a fresh call id", async () => {
    const { meter, entries, waits } = recorder();
    const metered = meteredProvider(
      provider(() => streaming(message(usage))),
      meter,
      async (entry) => {
        entries.push(entry);
      },
    );

    await collect(metered.stream(model, context));
    await collect(metered.streamSimple(model, context));
    await Promise.all(waits);

    expect(entries).toHaveLength(2);
    expect(entries[0]!.callId).not.toBe(entries[1]!.callId);
  });
});
