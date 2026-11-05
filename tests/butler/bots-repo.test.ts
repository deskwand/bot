import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BotsRepo } from "../../src/butler/bots-repo";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

describe("BotsRepo rename", () => {
  it("changes the name and leaves the rest of the row alone", async () => {
    const result = await runInDurableObject(
      butler("bots-repo-rename"),
      (_instance, state) => {
        const repo = new BotsRepo(state.storage.sql);
        repo.insert({ id: "b1", name: "价格哨兵" });
        const before = repo.get("b1");
        const ok = repo.rename("b1", "早报");
        return { ok, before, after: repo.get("b1") };
      },
    );

    expect(result.ok).toBe(true);
    expect(result.before).toMatchObject({ id: "b1", name: "价格哨兵" });
    expect(result.after).toMatchObject({ id: "b1", name: "早报" });
    expect(result.after?.createdAt).toBe(result.before?.createdAt);
  });

  it("returns false for a missing row", async () => {
    const ok = await runInDurableObject(
      butler("bots-repo-rename-missing"),
      (_instance, state) =>
        new BotsRepo(state.storage.sql).rename("b9", "早报"),
    );

    expect(ok).toBe(false);
  });
});
