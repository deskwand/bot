import { describe, expect, it } from "vitest";
import { config } from "../../src/config";
import { createModelsForEnv } from "../../src/llm/models";

function envWith(overrides: Record<string, string>): Env {
  return overrides as unknown as Env;
}

describe("createModelsForEnv", () => {
  it("resolves every configured model ref from the offline catalog", () => {
    const models = createModelsForEnv(
      envWith({ OPENCODE_API_KEY: "oc-test-key" }),
    );

    for (const ref of Object.values(config.models)) {
      const model = models.getModel(ref.provider, ref.id);
      expect(model).toBeDefined();
      expect(model).toMatchObject({
        provider: ref.provider,
        id: ref.id,
      });
    }
  });

  it("resolves the OpenCode Go key from the Worker env", async () => {
    const models = createModelsForEnv(
      envWith({ OPENCODE_API_KEY: "oc-test-key" }),
    );

    const auth = await models.getAuth("opencode-go");
    expect(auth?.source).toBe("OPENCODE_API_KEY");
    expect(auth?.auth.apiKey).toBe("oc-test-key");
  });
});
