import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import {
  WORKERS_AI_PAID_PLAN_MARKER,
  WORKERS_AI_QUOTA_MARKER,
} from "../../src/llm/model-errors";
import { createModelsForEnv } from "../../src/llm/models";
import {
  WORKERS_AI_BASE_URL,
  WORKERS_AI_PROVIDER_ID,
} from "../../src/llm/workers-ai";

const MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";

const getTimeTool = {
  name: "get_time",
  description: "获取当前时间",
  parameters: Type.Object({}),
};

const baseEnv = {};

const quotaExhaustedSample =
  '{"name":"AiError","internalCode":4006,"httpCode":429,"message":"AiError: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare\'s Workers Paid plan if you would like to continue usage.","requestId":"req-1"}';

const paidPlanSample =
  '{"name":"AiError","internalCode":5035,"httpCode":403,"message":"AiError: Model @cf/zai-org/glm-5.3-flash is not available on the Workers Free plan. Upgrade to access this model: https://dash.cloudflare.com/?to=/:account/workers/plans","requestId":"req-2"}';

function sse(chunks: unknown[]): string {
  return (
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

function chunk(delta: unknown, finishReason: string | null): unknown {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const sseBody = sse([
  chunk({ role: "assistant", content: "好" }, null),
  chunk(
    {
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "get_time", arguments: "{}" },
        },
      ],
    },
    null,
  ),
  chunk({}, "tool_calls"),
]);

function fakeBinding(
  body: string,
  init: { status?: number; contentType?: string } = {},
): {
  aiGatewayLogId: null;
  fetch: ReturnType<typeof vi.fn>;
} {
  return {
    aiGatewayLogId: null,
    fetch: vi.fn(
      async () =>
        new Response(body, {
          status: init.status ?? 200,
          headers: {
            "content-type": init.contentType ?? "text/event-stream",
          },
        }),
    ),
  };
}

describe("workersAiProvider", () => {
  it("streams through the AI binding with placeholder auth", async () => {
    const fakeAi = fakeBinding(sseBody);
    const env = { ...baseEnv, AI: fakeAi } as unknown as Env;
    const models = createModelsForEnv(env);
    const model = models.getModel(WORKERS_AI_PROVIDER_ID, MODEL_ID)!;

    const result = await models.complete(
      model,
      {
        messages: [{ role: "user", content: "几点", timestamp: 0 }],
        tools: [getTimeTool],
      },
      { headers: { Authorization: "Bearer leaked" } },
    );

    expect(result.stopReason).toBe("toolUse");
    expect(
      result.content.some((c) => c.type === "toolCall" && c.name === "get_time"),
    ).toBe(true);

    const [input, init] = fakeAi.fetch.mock.calls[0]!;
    expect(String(input)).toBe(`${WORKERS_AI_BASE_URL}/chat/completions`);
    const headers = new Headers(init!.headers);
    expect(headers.get("cf-aig-authorization")).toBe(
      "Bearer cloudflare-gateway-binding",
    );
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("skips Workers AI when the binding has no fetch", () => {
    const models = createModelsForEnv({ ...baseEnv, AI: {} } as unknown as Env);

    expect(models.getModel(WORKERS_AI_PROVIDER_ID, MODEL_ID)).toBeUndefined();
    expect(models.getModel("opencode-go", "deepseek-v4.1-flash")).toBeDefined();
  });

  it("replaces an exhausted free allowance with a stable marker", async () => {
    const fakeAi = fakeBinding(quotaExhaustedSample, {
      status: 429,
      contentType: "application/json",
    });
    const env = { ...baseEnv, AI: fakeAi } as unknown as Env;
    const models = createModelsForEnv(env);
    const model = models.getModel(WORKERS_AI_PROVIDER_ID, MODEL_ID)!;

    const result = await models.complete(model, {
      messages: [{ role: "user", content: "你好", timestamp: 0 }],
    });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(WORKERS_AI_QUOTA_MARKER);
    expect(fakeAi.fetch).toHaveBeenCalledTimes(1);
  });

  it("replaces a paid-plan-only model error with a stable marker", async () => {
    const fakeAi = fakeBinding(paidPlanSample, {
      status: 403,
      contentType: "application/json",
    });
    const env = { ...baseEnv, AI: fakeAi } as unknown as Env;
    const models = createModelsForEnv(env);
    const model = models.getModel(WORKERS_AI_PROVIDER_ID, MODEL_ID)!;

    const result = await models.complete(model, {
      messages: [{ role: "user", content: "你好", timestamp: 0 }],
    });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(WORKERS_AI_PAID_PLAN_MARKER);
    expect(fakeAi.fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves an ordinary upstream error unchanged", async () => {
    const fakeAi = fakeBinding("upstream exploded", {
      status: 500,
      contentType: "text/plain",
    });
    const env = { ...baseEnv, AI: fakeAi } as unknown as Env;
    const models = createModelsForEnv(env);
    const model = models.getModel(WORKERS_AI_PROVIDER_ID, MODEL_ID)!;

    const result = await models.complete(model, {
      messages: [{ role: "user", content: "你好", timestamp: 0 }],
    });

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toBe(WORKERS_AI_QUOTA_MARKER);
    expect(result.errorMessage).not.toBe(WORKERS_AI_PAID_PLAN_MARKER);
  });
});
