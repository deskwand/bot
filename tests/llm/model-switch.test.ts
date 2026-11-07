import { describe, expect, it } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { assertModelWindowSwitch, ModelSwitchError } from "../../src/llm/model-switch";

const provider = fauxProvider({ provider: "window-test", models: [
  { id: "large", contextWindow: 128000 },
  { id: "equal", contextWindow: 128000 },
  { id: "small", contextWindow: 32000 },
  { id: "tiny", contextWindow: 16000 },
  { id: "unknown", contextWindow: 0 },
] });
const models = createModels();
models.setProvider(provider.provider);
const ref = (id: string) => ({ provider: provider.provider.id, id });

describe("static model window guard", () => {
  it("explains a downgrade in English with actual window sizes", () => {
    expect(() => assertModelWindowSwitch(models, ref("large"), ref("tiny"), "en"))
      .toThrow("128000-token context window");
    expect(() => assertModelWindowSwitch(models, ref("large"), ref("tiny"), "en"))
      .toThrow("16000 tokens");
  });
  it("allows equal windows and upgrades", () => {
    expect(() => assertModelWindowSwitch(models, ref("large"), ref("equal"), "zh")).not.toThrow();
    expect(() => assertModelWindowSwitch(models, ref("small"), ref("large"), "zh")).not.toThrow();
    expect(() => assertModelWindowSwitch(models, ref("large"), ref("small"), "zh")).not.toThrow();
  });
  it.each([["missing", "large"], ["large", "missing"], ["unknown", "large"], ["large", "unknown"]])
    ("rejects an unverifiable switch from %s to %s", (from, to) => {
      expect(() => assertModelWindowSwitch(models, ref(from), ref(to), "zh")).toThrow(ModelSwitchError);
    });
  it("leaves initial model selection and unchanged legacy references alone", () => {
    expect(() => assertModelWindowSwitch(models, undefined, ref("small"), "zh")).not.toThrow();
    expect(() => assertModelWindowSwitch(models, ref("missing"), ref("missing"), "zh")).not.toThrow();
  });
});
