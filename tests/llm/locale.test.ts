import { describe, expect, it } from "vitest";
import validConfig from "../../contracts/fixtures/config-valid.json";
import {
  isQuotaExhaustedSummary,
  PAID_PLAN_REQUIRED_TEXT,
  QUOTA_EXHAUSTED_TEXT,
  WORKERS_AI_PAID_PLAN_MARKER,
  WORKERS_AI_QUOTA_MARKER,
  modelKeyMissingText,
  modelUnavailableShortText,
  modelUnavailableText,
  paidPlanRequiredText,
  quotaExhaustedText,
  userTextForModelError,
  workersAiBindingUnavailableText,
} from "../../src/llm/model-errors";
import { createModelsForEnv, modelReadiness } from "../../src/llm/models";

const HAN = /\p{Script=Han}/u;

function expectEnglish(text: string): void {
  expect(text).not.toMatch(HAN);
}

function envWith(overrides: Record<string, unknown>): Env {
  return overrides as unknown as Env;
}

describe("model error copy", () => {
  it("keeps the Chinese copy", () => {
    expect(quotaExhaustedText("zh")).toBe(
      "今天的 Cloudflare 免费模型额度已用完（UTC 0 点重置，即北京时间 8 点）。想继续用，可以在桌面端模型页换成自己的模型 key。",
    );
    expect(paidPlanRequiredText("zh")).toBe(
      "当前模型需要 Cloudflare Workers 付费计划，请在桌面端模型页换成免费计划可用的模型（例如默认的 Gemma 4 26B）。",
    );
    expect(modelUnavailableText("zh", "deepseek", "deepseek-flash")).toBe(
      "模型 deepseek/deepseek-flash 不可用，请在桌面端模型页重新选择",
    );
    expect(modelUnavailableShortText("zh", "deepseek", "deepseek-flash")).toBe(
      "模型 deepseek/deepseek-flash 不可用",
    );
    expect(modelKeyMissingText("zh", "deepseek", "MODEL_KEY_DEEPSEEK")).toBe(
      "模型 deepseek 没有配置 key（MODEL_KEY_DEEPSEEK），请在桌面端模型页填写",
    );
    expect(workersAiBindingUnavailableText("zh")).toBe(
      "Workers AI binding 不可用，请在桌面端重新部署",
    );
    expect(QUOTA_EXHAUSTED_TEXT).toBe(quotaExhaustedText("zh"));
    expect(PAID_PLAN_REQUIRED_TEXT).toBe(paidPlanRequiredText("zh"));
  });

  it("is English in en", () => {
    const texts = [
      quotaExhaustedText("en"),
      paidPlanRequiredText("en"),
      modelUnavailableText("en", "deepseek", "deepseek-flash"),
      modelUnavailableShortText("en", "deepseek", "deepseek-flash"),
      modelKeyMissingText("en", "deepseek", "MODEL_KEY_DEEPSEEK"),
      workersAiBindingUnavailableText("en"),
    ];
    for (const text of texts) expectEnglish(text);
    expect(texts[2]).toContain("deepseek/deepseek-flash");
    expect(texts[3]).toContain("deepseek/deepseek-flash");
    expect(texts[4]).toContain("MODEL_KEY_DEEPSEEK");
  });

  it("maps markers to the requested language", () => {
    expect(userTextForModelError(WORKERS_AI_QUOTA_MARKER, "zh")).toBe(
      QUOTA_EXHAUSTED_TEXT,
    );
    expect(userTextForModelError(WORKERS_AI_QUOTA_MARKER, "en")).toBe(
      quotaExhaustedText("en"),
    );
    expect(userTextForModelError(WORKERS_AI_PAID_PLAN_MARKER, "en")).toBe(
      paidPlanRequiredText("en"),
    );
  });

  it("recognizes the quota summary in both languages", () => {
    expect(isQuotaExhaustedSummary(quotaExhaustedText("zh"))).toBe(true);
    expect(isQuotaExhaustedSummary(quotaExhaustedText("en"))).toBe(true);
    expect(isQuotaExhaustedSummary("boom")).toBe(false);
  });
});

describe("modelReadiness locale", () => {
  const ref = { provider: "deepseek", id: "deepseek-flash" };

  it("reports a missing key in English", () => {
    const env = envWith({
      DESKWAND_CONFIG: { ...validConfig, locale: "en" },
    });
    const models = createModelsForEnv(env);

    expectEnglish(modelReadiness(env, models, ref) ?? "");
    expect(modelReadiness(env, models, ref)).toContain("MODEL_KEY_DEEPSEEK");
  });

  it("reports a missing Workers AI binding in English", () => {
    const env = envWith({
      DESKWAND_CONFIG: { ...validConfig, locale: "en" },
      AI: {},
    });
    const models = createModelsForEnv(env);

    expectEnglish(
      modelReadiness(env, models, {
        provider: "workers-ai",
        id: "@cf/google/gemma-4-26b-a4b-it",
      }) ?? "",
    );
  });
});
