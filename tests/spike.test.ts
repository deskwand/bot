import { env, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createModelsForEnv, setModelOverride } from "../src/llm/models";
import { scriptedModel } from "./helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

afterEach(() => {
  setModelOverride(null);
});

describe("PiHarness on a Durable Object", () => {
  it("runs a tool call with a scripted model", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "echo", args: { text: "hi" } }] },
        { text: "echo said hi" },
      ]),
    );
    const stub = env.TEST_HARNESS.get(env.TEST_HARNESS.idFromName("s1"));

    expect(await stub.ask("say hi")).toBe("echo said hi");
    expect(await stub.echoes()).toBe(1);
  });

  it("resolves the Anthropic key from the Worker env", async () => {
    const models = createModelsForEnv({
      ANTHROPIC_API_KEY: "sk-ant-test",
    } as Env);

    expect(models.getModel("anthropic", "claude-sonnet-5-5")).toBeDefined();
    const auth = await models.getAuth("anthropic");
    expect(auth?.source).toBe("ANTHROPIC_API_KEY");
    expect(auth?.auth.apiKey).toBe("sk-ant-test");
  });

  it("settles a submitted operation and can be waited on again", async () => {
    setModelOverride(scriptedModel([{ text: "hello" }]));
    const stub = env.TEST_HARNESS.get(env.TEST_HARNESS.idFromName("s2"));

    const receipt = await stub.submitPrompt("hi", "op-1");
    expect(receipt.accepted).toBe(true);

    const first = await stub.waitFor("op-1");
    expect(first).toMatchObject({ status: "done", text: "hello" });
    // `wait` resolves from durable storage, so calling it again yields the
    // same result rather than hanging or re-running the model.
    expect(await stub.waitFor("op-1")).toEqual(first);

    const duplicate = await stub.submitPrompt("hi", "op-1");
    expect(duplicate.accepted).toBe(false);
  });

  it("can wait on an operation after the object is evicted", async () => {
    setModelOverride(scriptedModel([{ text: "durable" }]));
    const stub = env.TEST_HARNESS.get(env.TEST_HARNESS.idFromName("s3"));

    expect((await stub.submitPrompt("hi", "op-2")).accepted).toBe(true);
    expect((await stub.waitFor("op-2")).text).toBe("durable");

    await evictDurableObject(stub);

    expect((await stub.waitFor("op-2")).text).toBe("durable");
  });
});
