import { env } from "cloudflare:test";
import type { Credential } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  deleteModelCredential,
  modelCredentialStore,
  readModelCredential,
  saveModelCredential,
} from "../../src/llm/model-auth";

const CODEX = "openai-codex";

function oauth(access: string): Credential {
  return { type: "oauth", access, refresh: "refresh-token", expires: 1_900_000_000_000 };
}

function fakeEnv(LIFE: unknown): Env {
  return { LIFE } as unknown as Env;
}

/** Any use of the binding proves an API-key provider paid for a round trip. */
const unreachableLife = {
  idFromName: () => {
    throw new Error("credential store must not open the life object here");
  },
  get: () => {
    throw new Error("credential store must not open the life object here");
  },
};

describe("model credential store", () => {
  it("leaves API-key providers on their MODEL_KEY_* path", async () => {
    const store = modelCredentialStore(fakeEnv(unreachableLife));
    let called = false;

    expect(await readModelCredential(fakeEnv(unreachableLife), "deepseek")).toBeUndefined();
    const result = await store.modify("deepseek", async () => {
      called = true;
      return undefined;
    });

    expect(called).toBe(false);
    expect(result).toBeUndefined();
    await store.delete("deepseek");
  });

  it("stores and reads a subscription credential", async () => {
    const store = modelCredentialStore(env);
    await store.modify(CODEX, async () => oauth("access-1"));
    try {
      expect(await readModelCredential(env, CODEX)).toEqual(oauth("access-1"));
      expect(await store.list()).toEqual([{ providerId: CODEX, type: "oauth" }]);
    } finally {
      await deleteModelCredential(env, CODEX);
    }
    expect(await readModelCredential(env, CODEX)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("feeds the current credential to modify and persists the result", async () => {
    const store = modelCredentialStore(env);
    await saveModelCredential(env, CODEX, oauth("first"));
    try {
      const next = await store.modify(CODEX, async (current) => {
        expect(current).toEqual(oauth("first"));
        return oauth("second");
      });
      expect(next).toEqual(oauth("second"));
      expect(await readModelCredential(env, CODEX)).toEqual(oauth("second"));
    } finally {
      await deleteModelCredential(env, CODEX);
    }
  });

  it("serializes concurrent writes per provider", async () => {
    const store = modelCredentialStore(env);
    const order: number[] = [];

    try {
      await Promise.all(
        [0, 1, 2, 3, 4].map((index) =>
          store.modify(CODEX, async () => {
            // Yield so an unserialized implementation interleaves here.
            await new Promise((resolve) => setTimeout(resolve, 1));
            order.push(index);
            return oauth(`access-${index}`);
          }),
        ),
      );

      expect(order).toEqual([0, 1, 2, 3, 4]);
      expect(await readModelCredential(env, CODEX)).toEqual(oauth("access-4"));
    } finally {
      await deleteModelCredential(env, CODEX);
    }
  });

  it("keeps the winner's credential when two writers race", async () => {
    // Two isolates can read the same expired credential and both refresh it.
    // The life object's compare-and-set makes the loser adopt the winner's
    // value instead of writing back a rotated-out refresh token.
    const store = modelCredentialStore(env);
    await saveModelCredential(env, CODEX, oauth("first"));
    try {
      const loser = await store.modify(CODEX, async (current) => {
        // The winner lands between this read and the write below.
        await saveModelCredential(env, CODEX, {
          type: "oauth",
          access: "winner",
          refresh: "winner-refresh",
          expires: 1_900_000_000_000,
        });
        return {
          type: "oauth",
          access: "loser",
          refresh: "loser-refresh",
          expires: current?.type === "oauth" ? current.expires : 0,
        };
      });

      expect(loser).toEqual({
        type: "oauth",
        access: "winner",
        refresh: "winner-refresh",
        expires: 1_900_000_000_000,
      });
      expect(await readModelCredential(env, CODEX)).toMatchObject({
        access: "winner",
      });
    } finally {
      await deleteModelCredential(env, CODEX);
    }
  });

  it("treats a deployment without the binding as signed out", async () => {
    expect(await readModelCredential(fakeEnv(undefined), CODEX)).toBeUndefined();
  });
});
