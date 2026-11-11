import { describe, expect, it } from "vitest";
import keyNames from "../../contracts/fixtures/model-key-names.json";
import type { ModelsConfig } from "../../src/config";
import {
  BUILTIN_PROVIDER_IDS,
  modelsConfigValid,
  secretNameFor,
  type CustomProviderConfig,
} from "../../src/llm/providers";

const myProxy: CustomProviderConfig = {
  id: "my-proxy",
  api: "openai-completions",
  baseUrl: "https://proxy.example.com/v1",
  models: [{ id: "gpt-5.6" }],
};

function config(overrides: Partial<ModelsConfig> = {}): ModelsConfig {
  return {
    butler: { provider: "deepseek", id: "deepseek-flash" },
    task: { provider: "deepseek", id: "deepseek-flash" },
    ...overrides,
  };
}

describe("secretNameFor", () => {
  for (const { id, secret } of keyNames) {
    it(`derives ${secret} from ${id}`, () => {
      expect(secretNameFor(id)).toBe(secret);
    });
  }
});

describe("modelsConfigValid", () => {
  it("knows the generated built-in providers", () => {
    expect(BUILTIN_PROVIDER_IDS.has("deepseek")).toBe(true);
    expect(modelsConfigValid(config())).toBe(true);
  });

  it("accepts a model declared by a custom provider", () => {
    expect(
      modelsConfigValid(
        config({
          butler: { provider: "my-proxy", id: "gpt-5.6" },
          customProviders: [myProxy],
        }),
      ),
    ).toBe(true);
  });

  it("accepts a built-in model id that is not in the catalog", () => {
    expect(
      modelsConfigValid(
        config({
          butler: { provider: "deepseek", id: "not-in-catalog" },
        }),
      ),
    ).toBe(true);
  });

  it("rejects a custom id that collides with a built-in provider", () => {
    expect(
      modelsConfigValid(
        config({ customProviders: [{ ...myProxy, id: "deepseek" }] }),
      ),
    ).toBe(false);
  });

  it("rejects duplicate custom provider ids", () => {
    expect(
      modelsConfigValid(
        config({ customProviders: [myProxy, { ...myProxy }] }),
      ),
    ).toBe(false);
  });

  it("rejects duplicate model ids inside one custom provider", () => {
    expect(
      modelsConfigValid(
        config({
          customProviders: [
            { ...myProxy, models: [{ id: "gpt-5.6" }, { id: "gpt-5.6" }] },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects an undeclared provider", () => {
    expect(
      modelsConfigValid(
        config({ butler: { provider: "ghost", id: "ghost-model" } }),
      ),
    ).toBe(false);
  });

  it("rejects a custom model id the provider does not declare", () => {
    expect(
      modelsConfigValid(
        config({
          task: { provider: "my-proxy", id: "gpt-5.5" },
          customProviders: [myProxy],
        }),
      ),
    ).toBe(false);
  });

  function withCost(cost: unknown): ModelsConfig {
    return config({
      customProviders: [
        {
          ...myProxy,
          models: [{ id: "gpt-5.6", cost }],
        } as unknown as CustomProviderConfig,
      ],
    });
  }

  it("rejects a custom model with a negative price", () => {
    expect(
      modelsConfigValid(withCost({ input: -0.5, output: 1.5 })),
    ).toBe(false);
  });

  it("rejects a custom model with a non-numeric price", () => {
    expect(
      modelsConfigValid(withCost({ input: "free", output: 1.5 })),
    ).toBe(false);
  });
});
