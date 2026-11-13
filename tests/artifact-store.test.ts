import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { artifactStore, type ArtifactStore } from "../src/artifact-store";

describe("artifactStore", () => {
  it("returns the R2 bucket itself when no local store is bound", () => {
    expect(artifactStore({ ARTIFACTS: env.ARTIFACTS, ARTIFACT_STORE: undefined })).toBe(env.ARTIFACTS);
  });
  it("names both bindings when neither is present", () => {
    expect(() => artifactStore({ ARTIFACTS: undefined as never, ARTIFACT_STORE: undefined }))
      .toThrow(/ARTIFACTS.*ARTIFACT_STORE/);
  });
  it("accepts an R2 bucket structurally", () => {
    const store: ArtifactStore = env.ARTIFACTS; // compile-time check
    expect(store).toBeDefined();
  });
  it("reads through the local Durable Object store when bound", async () => {
    const store = artifactStore({
      ARTIFACTS: undefined as never,
      ARTIFACT_STORE: env.STORE_TEST,
    });
    const key = `${crypto.randomUUID()}/do-branch`;

    await store.put(key, "hello");
    const object = await store.get(key);

    expect(await object!.text()).toBe("hello");
  });
});
