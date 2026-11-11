import { describe, expect, it } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createModelsForEnv,
  modelAcceptsImages,
  modelReadiness,
  registerTestProvider,
  setModelOverride,
} from "../../src/llm/models";

const customConfig = {
  schemaVersion: 1,
  owner: { telegramUserIds: [] },
  models: {
    butler: { provider: "my-proxy", id: "gpt-5.6" },
    task: { provider: "deepseek", id: "deepseek-flash" },
    customProviders: [
      {
        id: "my-proxy",
        name: "My Proxy",
        api: "openai-completions",
        baseUrl: "https://proxy.example.com/v1",
        models: [{ id: "gpt-5.6" }],
      },
    ],
  },
  mcpServers: [],
};

function envWith(overrides: Record<string, unknown>): Env {
  return overrides as unknown as Env;
}

describe("createModelsForEnv", () => {
  it("reads each built-in provider's key from MODEL_KEY_<ID>", async () => {
    const models = createModelsForEnv(
      envWith({
        MODEL_KEY_OPENCODE_GO: "a",
        MODEL_KEY_OPENCODE: "b",
      }),
    );

    const goAuth = await models.getAuth("opencode-go");
    expect(goAuth?.auth.apiKey).toBe("a");
    expect(goAuth?.source).toBe("MODEL_KEY_OPENCODE_GO");

    const opencodeAuth = await models.getAuth("opencode");
    expect(opencodeAuth?.auth.apiKey).toBe("b");
    expect(opencodeAuth?.source).toBe("MODEL_KEY_OPENCODE");
  });

  it("ignores legacy and native variable names", async () => {
    const models = createModelsForEnv(
      envWith({
        ANTHROPIC_API_KEY: "a",
        OPENCODE_API_KEY: "b",
        DEEPSEEK_API_KEY: "c",
      }),
    );

    for (const provider of ["anthropic", "opencode-go", "deepseek"]) {
      expect(await models.getAuth(provider)).toBeUndefined();
    }
  });

  it("treats a blank key as missing", async () => {
    const models = createModelsForEnv(
      envWith({ MODEL_KEY_DEEPSEEK: "  " }),
    );

    expect(await models.getAuth("deepseek")).toBeUndefined();
  });

  it("registers configured custom providers", async () => {
    const models = createModelsForEnv(
      envWith({
        DESKWAND_CONFIG: customConfig,
        MODEL_KEY_MY_PROXY: "k",
      }),
    );

    expect(models.getModel("my-proxy", "gpt-5.6")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
      contextWindow: 128000,
      maxTokens: 8192,
    });

    const auth = await models.getAuth("my-proxy");
    expect(auth?.auth.apiKey).toBe("k");
    expect(auth?.source).toBe("MODEL_KEY_MY_PROXY");
  });

  it("builds models without a readable config", () => {
    for (const config of [undefined, "{"]) {
      const models = createModelsForEnv(envWith({ DESKWAND_CONFIG: config }));
      expect(models.getModel("deepseek", "deepseek-flash")).toBeDefined();
    }
  });

  it("carries a custom model's prices", () => {
    const models = createModelsForEnv(
      envWith({
        DESKWAND_CONFIG: {
          ...customConfig,
          models: {
            ...customConfig.models,
            customProviders: [
              {
                ...customConfig.models.customProviders[0],
                models: [
                  { id: "gpt-5.6", cost: { input: 0.5, output: 1.5 } },
                ],
              },
            ],
          },
        },
      }),
    );

    expect(models.getModel("my-proxy", "gpt-5.6")?.cost).toEqual({
      input: 0.5,
      output: 1.5,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("defaults a custom model without prices to zero", () => {
    const models = createModelsForEnv(
      envWith({ DESKWAND_CONFIG: customConfig }),
    );

    expect(models.getModel("my-proxy", "gpt-5.6")?.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("leaves providers untouched when no meter is given", () => {
    const faux = fauxProvider({
      provider: "unmetered-test",
      api: "unmetered-test",
      models: [{ id: "m" }],
    });
    registerTestProvider(faux.provider);

    const models = createModelsForEnv(envWith({}));

    expect(models.getProvider("unmetered-test")?.stream).toBe(
      faux.provider.stream,
    );
  });
});

describe("modelReadiness", () => {
  const ref = { provider: "deepseek", id: "deepseek-flash" };

  it("reports a missing key", () => {
    const env = envWith({});
    const models = createModelsForEnv(env);

    expect(modelReadiness(env, models, ref)).toBe(
      "模型 deepseek 没有配置 key（MODEL_KEY_DEEPSEEK），请在桌面端模型页填写",
    );
  });

  it("reports a model missing from the catalog", () => {
    const env = envWith({ MODEL_KEY_DEEPSEEK: "k" });
    const models = createModelsForEnv(env);

    expect(
      modelReadiness(env, models, {
        provider: "deepseek",
        id: "not-in-catalog",
      }),
    ).toBe("模型 deepseek/not-in-catalog 不可用，请在桌面端模型页重新选择");
  });

  it("returns undefined when the model and key are available", () => {
    const env = envWith({ MODEL_KEY_DEEPSEEK: "k" });
    const models = createModelsForEnv(env);

    expect(modelReadiness(env, models, ref)).toBeUndefined();
  });

  describe("Workers AI", () => {
    const workersRef = {
      provider: "workers-ai",
      id: "@cf/google/gemma-4-26b-a4b-it",
    };
    const fakeAi = { aiGatewayLogId: null, fetch: async () => new Response("") };

    it("needs no key when the AI binding is available", () => {
      const env = envWith({ AI: fakeAi });
      const models = createModelsForEnv(env);

      expect(modelReadiness(env, models, workersRef)).toBeUndefined();
    });

    it("reports a missing AI binding", () => {
      const env = envWith({ AI: {} });
      const models = createModelsForEnv(env);

      expect(modelReadiness(env, models, workersRef)).toBe(
        "Workers AI binding 不可用，请在桌面端重新部署",
      );
    });

    it("reports a model missing from the catalog", () => {
      const env = envWith({ AI: fakeAi });
      const models = createModelsForEnv(env);

      expect(
        modelReadiness(env, models, {
          provider: "workers-ai",
          id: "@cf/not-a-model",
        }),
      ).toBe("模型 workers-ai/@cf/not-a-model 不可用，请在桌面端模型页重新选择");
    });
  });
});

describe("modelAcceptsImages", () => {
  it("reports a custom provider model as text-only", () => {
    const models = createModelsForEnv(
      envWith({ DESKWAND_CONFIG: customConfig, MODEL_KEY_MY_PROXY: "k" }),
    );

    expect(modelAcceptsImages(models, { provider: "my-proxy", id: "gpt-5.6" })).toBe(
      false,
    );
  });

  it("follows the built-in catalog for a real model", () => {
    const models = createModelsForEnv(envWith({ DESKWAND_CONFIG: customConfig }));

    expect(
      modelAcceptsImages(models, { provider: "deepseek", id: "deepseek-flash" }),
    ).toBe(models.getModel("deepseek", "deepseek-flash")?.input.includes("image") ?? false);
  });

  it("lets the test override through", () => {
    setModelOverride({ provider: "scripted", id: "scripted-x" });

    try {
      expect(
        modelAcceptsImages(createModelsForEnv(envWith({})), {
          provider: "scripted",
          id: "scripted-x",
        }),
      ).toBe(true);
    } finally {
      setModelOverride(null);
    }
  });
});
