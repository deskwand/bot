import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TurnStore } from "../../src/butler/turn-store";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function withStore<T>(name: string, fn: (store: TurnStore) => T): Promise<T> {
  return runInDurableObject(butler(name), (_instance, state) =>
    fn(new TurnStore(state.storage.sql)),
  );
}

describe("TurnStore", () => {
  it("inserts once per operation", async () => {
    const inserted = await withStore("turns-insert", (store) => {
      const first = store.insertIfAbsent({ operationId: "a", submittedAt: 10 });
      const second = store.insertIfAbsent({ operationId: "a", submittedAt: 20 });
      return [first, second, store.list().length];
    });
    expect(inserted).toEqual([true, false, 1]);
  });

  it("lists rows in submission order", async () => {
    const ids = await withStore("turns-order", (store) => {
      store.insertIfAbsent({ operationId: "b", submittedAt: 20 });
      store.insertIfAbsent({ operationId: "a", submittedAt: 10 });
      return store.list().map((row) => row.operationId);
    });
    expect(ids).toEqual(["a", "b"]);
  });

  it("keeps the optimistic start while the turn runs", async () => {
    const row = await withStore("turns-start", (store) => {
      store.insertIfAbsent({ operationId: "a", submittedAt: 100 });
      store.start("a", 200, false);
      store.start("a", 900, false);
      return store.get("a");
    });
    // Inserted optimistically at submit time: the ack deadline counts from there.
    expect(row).toMatchObject({ startedAt: 100, activityAt: 100 });
  });

  it("restarts the clock for a turn that had to queue", async () => {
    const row = await withStore("turns-queued", (store) => {
      store.insertIfAbsent({ operationId: "a", submittedAt: 100 });
      store.start("a", 5_000, true);
      const queued = store.get("a");
      store.start("a", 9_000, false);
      return { queued, running: store.get("a") };
    });
    expect(row.queued).toMatchObject({ startedAt: null });
    expect(row.running).toMatchObject({ startedAt: 9_000, activityAt: 9_000 });
  });

  it("moves the activity clock only when the signature changes", async () => {
    const row = await withStore("turns-observe", (store) => {
      store.insertIfAbsent({ operationId: "a", submittedAt: 0 });
      store.start("a", 0, false);
      store.observe("a", "one", 1_000);
      store.observe("a", "one", 2_000);
      store.observe("a", "two", 3_000);
      return store.get("a");
    });
    expect(row).toMatchObject({ signature: "two", activityAt: 3_000 });
  });

  it("clears an earlier stall notice when activity returns", async () => {
    const row = await withStore("turns-rearm", (store) => {
      store.insertIfAbsent({ operationId: "a", submittedAt: 0 });
      store.start("a", 0, false);
      store.observe("a", "one", 0);
      store.notice("a", 600);
      store.observe("a", "two", 900);
      return store.get("a");
    });
    expect(row).toMatchObject({ noticeAt: null, activityAt: 900 });
  });

  it("hides an abandoned turn without letting it be re-created", async () => {
    const state = await withStore("turns-abandon", (store) => {
      store.insertIfAbsent({ operationId: "a", submittedAt: 0 });
      store.abandon("a", 100);
      return {
        list: store.list().length,
        get: store.get("a")?.abandonedAt,
        again: store.insertIfAbsent({ operationId: "a", submittedAt: 200 }),
      };
    });
    expect(state).toEqual({ list: 0, get: 100, again: false });
  });

  it("keeps a retry deadline after a failed send", async () => {
    const row = await withStore("turns-retry-at", (store) => {
      store.insertIfAbsent({ operationId: "a", submittedAt: 0 });
      const attempts = store.fail("a");
      store.retryAt("a", 90_000);
      return { attempts, row: store.get("a") };
    });
    expect(row.attempts).toBe(1);
    expect(row.row).toMatchObject({ attempts: 1, retryAt: 90_000, deliveringAt: null });
  });

  it("counts a failed send and clears the delivering mark", async () => {
    const row = await withStore("turns-fail", (store) => {
      store.insertIfAbsent({ operationId: "a", submittedAt: 0 });
      store.delivering("a", 100);
      store.fail("a");
      return store.get("a");
    });
    expect(row).toMatchObject({ deliveringAt: null, attempts: 1 });
  });

  it("claimAnswer lets only the first operation claim an answer", async () => {
    const claims = await withStore("answers-claim", (store) => [
      store.claimAnswer("a1", "op1", 100),
      store.claimAnswer("a1", "op2", 200),
    ]);
    expect(claims).toEqual([true, false]);
  });

  it("claimAnswer is idempotent for the claimant", async () => {
    const claims = await withStore("answers-idempotent", (store) => [
      store.claimAnswer("a1", "op1", 100),
      store.claimAnswer("a1", "op1", 200),
    ]);
    expect(claims).toEqual([true, true]);
  });

  it("pruneAnswers removes only old claims", async () => {
    const claims = await withStore("answers-prune", (store) => {
      store.claimAnswer("a1", "op1", 100);
      store.claimAnswer("a2", "op2", 900);
      store.pruneAnswers(500);
      return {
        old: store.claimAnswer("a1", "op3", 600),
        recent: store.claimAnswer("a2", "op3", 600),
      };
    });
    expect(claims).toEqual({ old: true, recent: false });
  });

  it("forgets a delivered turn", async () => {
    const row = await withStore("turns-remove", (store) => {
      store.insertIfAbsent({ operationId: "a", submittedAt: 0 });
      store.remove("a");
      return store.get("a");
    });
    expect(row).toBeUndefined();
  });
});
