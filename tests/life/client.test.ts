import { describe, expect, it } from "vitest";
import { readTier, readVitals } from "../../src/life/client";

function fakeEnv(LIFE: unknown): Env {
  return { LIFE } as unknown as Env;
}

const failingLife = {
  idFromName: () => "life-id",
  get: () => ({
    vitals: async () => {
      throw new Error("life down");
    },
  }),
};

describe("life client", () => {
  it("falls back to ample when the DO call fails", async () => {
    expect(await readTier(fakeEnv(failingLife))).toBe("ample");
    expect(await readVitals(fakeEnv(failingLife))).toBeNull();
  });

  it("falls back when the LIFE binding is missing", async () => {
    expect(await readTier(fakeEnv(undefined))).toBe("ample");
    expect(await readVitals(fakeEnv(undefined))).toBeNull();
  });
});
