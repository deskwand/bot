import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Outbox } from "../../src/task/outbox";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("Outbox", () => {
  it("delivers in seq order and stops at first failure", async () => {
    const stub = env.TASK.get(env.TASK.idFromName("outbox-1"));

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const delivered: number[] = [];
      let fail = true;

      const ob = new Outbox(state.storage.sql, "t1", async (event) => {
        if (event.seq === 2 && fail) throw new Error("down");
        delivered.push(event.seq);
      });

      await ob.emit({ type: "started" });
      await ob.emit({ type: "progress", text: "a" });
      await ob.emit({ type: "progress", text: "b" });

      const beforeRetry = [...delivered];
      fail = false;
      await ob.flush();

      return { beforeRetry, delivered };
    });

    expect(result.beforeRetry).toEqual([1]);
    expect(result.delivered).toEqual([1, 2, 3]);
  });

  it("keeps undelivered events across Outbox instances", async () => {
    const stub = env.TASK.get(env.TASK.idFromName("outbox-2"));

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const first = new Outbox(state.storage.sql, "t2", async () => {
        throw new Error("down");
      });
      await first.emit({ type: "started" });
      await first.emit({ type: "progress", text: "retry me" });

      const delivered: number[] = [];
      const second = new Outbox(state.storage.sql, "t2", async (event) => {
        delivered.push(event.seq);
      });
      await second.flush();

      return delivered;
    });

    expect(result).toEqual([1, 2]);
  });
});
