import type { StreamOptions } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";
import { createModelsForEnv } from "../../src/llm/models";
import { oneShotOptions } from "../../src/llm/one-shot";

const MODEL_ID = "deepseek-v4.1-flash";
const SESSION_ID = "butler.speak:test";

function sse(): string {
  return (
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, delta: { content: "好" }, finish_reason: "stop" }],
    })}\n\n` + "data: [DONE]\n\n"
  );
}

type Captured = { url: string; headers: Headers };

function fakeFetch(calls: Captured[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    calls.push({
      url: String(request?.url ?? input),
      headers: new Headers(request?.headers ?? init?.headers),
    });
    return new Response(sse(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

async function complete(options: StreamOptions): Promise<Captured> {
  const calls: Captured[] = [];
  const env = { MODEL_KEY_OPENCODE_GO: "test-key" } as unknown as Env;
  const models = createModelsForEnv(env);
  const model = models.getModel("opencode-go", MODEL_ID)!;

  const result = await models.completeSimple(
    model,
    {
      systemPrompt: "改写这句话",
      messages: [{ role: "user", content: "已完成", timestamp: 0 }],
    },
    { ...options, fetch: fakeFetch(calls) },
  );

  expect(result.stopReason).toBe("stop");
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

describe("oneShotOptions", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await import("@earendil-works/pi-ai/api/openai-completions.lazy");
  });

  it("carries OpenCode's routing session on a one-shot request", async () => {
    const call = await complete(
      oneShotOptions(SESSION_ID, new AbortController().signal),
    );

    expect(call.url).toBe(
      "https://opencode.ai/inference/go/v1/chat/completions",
    );
    expect(call.headers.get("x-opencode-session")).toBe(SESSION_ID);
  });

  it("keeps the header when the caller already set one", async () => {
    const call = await complete({
      ...oneShotOptions(SESSION_ID, new AbortController().signal),
      headers: { "x-opencode-session": "caller" },
    });

    expect(call.headers.get("x-opencode-session")).toBe("caller");
  });
});
