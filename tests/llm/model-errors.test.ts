import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  isWorkersAiPaidPlanRequired,
  isWorkersAiQuotaExhausted,
  lastModelError,
} from "../../src/llm/model-errors";

const quotaExhaustedSample =
  '{"name":"AiError","internalCode":4006,"httpCode":429,"message":"AiError: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare\'s Workers Paid plan if you would like to continue usage.","requestId":"req-1"}';

const paidPlanSample =
  '{"name":"AiError","internalCode":5035,"httpCode":403,"message":"AiError: Model @cf/zai-org/glm-5.3-flash is not available on the Workers Free plan. Upgrade to access this model: https://dash.cloudflare.com/?to=/:account/workers/plans","requestId":"req-2"}';

const notQuotaSamples = [
  "429 Too Many Requests",
  "Rate limit exceeded",
  "500 Internal Server Error",
  "4006",
  "",
];

let nextEntry = 0;

const conversationId = 1 as EntryRecord["conversationId"];

function entry(
  ...model: ReturnType<typeof fauxAssistantMessage>[]
): EntryRecord {
  nextEntry += 1;
  return {
    id: nextEntry as EntryRecord["id"],
    conversationId,
    kind: "pi.assistant",
    model,
  };
}

describe("isWorkersAiQuotaExhausted", () => {
  it("recognizes the free allocation error", () => {
    expect(isWorkersAiQuotaExhausted(quotaExhaustedSample)).toBe(true);
    expect(isWorkersAiQuotaExhausted(`429 ${quotaExhaustedSample}`)).toBe(true);
  });

  it("does not treat throttling, server errors, or another limit as exhausted", () => {
    for (const sample of [...notQuotaSamples, paidPlanSample]) {
      expect(isWorkersAiQuotaExhausted(sample)).toBe(false);
    }
  });
});

describe("isWorkersAiPaidPlanRequired", () => {
  it("recognizes the paid-plan-only model error", () => {
    expect(isWorkersAiPaidPlanRequired(paidPlanSample)).toBe(true);
  });

  it("does not treat other errors as a plan requirement", () => {
    expect(isWorkersAiPaidPlanRequired(quotaExhaustedSample)).toBe(false);
    for (const sample of notQuotaSamples) {
      expect(isWorkersAiPaidPlanRequired(sample)).toBe(false);
    }
  });
});

describe("lastModelError", () => {
  it("returns the newest failed assistant message", () => {
    const entries = [
      entry(fauxAssistantMessage("old", { stopReason: "stop" })),
      entry(
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "boom",
        }),
      ),
      entry(
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "newer",
        }),
      ),
    ];

    expect(lastModelError(entries)).toBe("newer");
  });

  it("returns undefined when no assistant message failed", () => {
    const entries = [
      entry(fauxAssistantMessage("done", { stopReason: "stop" })),
      {
        id: 999 as EntryRecord["id"],
        conversationId,
        kind: "display",
      },
    ];

    expect(lastModelError(entries)).toBeUndefined();
  });

  it("stops at the newest assistant reply, ignoring errors before it", () => {
    const entries = [
      entry(
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "old",
        }),
      ),
      entry(fauxAssistantMessage("recovered", { stopReason: "stop" })),
    ];

    expect(lastModelError(entries)).toBeUndefined();
  });
});
