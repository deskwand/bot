import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BotStore } from "../../src/bot/bot-store";

function bot(name: string) {
  return env.BOT.get(env.BOT.idFromName(name));
}

describe("BotStore", () => {
  it("starts empty and round-trips meta", async () => {
    const meta = {
      botId: "b1",
      name: "价格哨兵",
      mission: "盯着价格",
      status: "active" as const,
      nextWakeAt: 1_000,
      defaultIntervalMs: 86_400_000,
      currentTaskId: null,
      consecutiveFailures: 0,
      wakesDay: "2026-11-03",
      wakesCount: 2,
      pendingSteer: ["先看主站"],
    };

    const result = await runInDurableObject(
      bot("b-store-meta"),
      (_instance, state) => {
        const store = new BotStore(state.storage.sql);
        const before = store.readMeta();
        store.writeMeta(meta);
        return { before, after: store.readMeta() };
      },
    );

    expect(result.before).toBeNull();
    expect(result.after).toEqual(meta);
  });

  it("records each run end once", async () => {
    const result = await runInDurableObject(
      bot("b-store-runs"),
      (_instance, state) => {
        const store = new BotStore(state.storage.sql);
        store.insertRun("t1", 100);
        return {
          first: store.endRun("t1", "completed", "看完了", 200),
          second: store.endRun("t1", "failed", "boom", 300),
          missing: store.endRun("t9", "completed", "抢跑", 400),
          missingEnded: store.runEnded("t9"),
          runs: store.recentRuns(10),
        };
      },
    );

    expect(result.first).toBe(true);
    expect(result.second).toBe(false);
    expect(result.missing).toBe(true);
    expect(result.missingEnded).toBe(true);
    expect(result.runs).toEqual([
      { taskId: "t9", startedAt: 400, endedAt: 400, outcome: "completed", summary: "抢跑", note: null },
      { taskId: "t1", startedAt: 100, endedAt: 200, outcome: "completed", summary: "看完了", note: null },
    ]);
  });

  it("returns recent runs newest first, limited", async () => {
    const result = await runInDurableObject(
      bot("b-store-recent"),
      (_instance, state) => {
        const store = new BotStore(state.storage.sql);
        store.insertRun("t1", 100);
        store.insertRun("t2", 200);
        store.insertRun("t3", 300);
        return {
          two: store.recentRuns(2),
          all: store.recentRuns(10),
        };
      },
    );

    expect(result.two.map((run) => run.taskId)).toEqual(["t3", "t2"]);
    expect(result.all.map((run) => run.taskId)).toEqual(["t3", "t2", "t1"]);
  });
});
