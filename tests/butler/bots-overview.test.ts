import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BotsRepo } from "../../src/butler/bots-repo";
import { buildOverviewRow } from "../../src/butler/butler-do";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const DAY_MS = 86_400_000;

const META = {
  botId: "b1",
  name: "好的",
  mission: "盯着价格",
  status: "active" as const,
  nextWakeAt: null,
  defaultIntervalMs: DAY_MS,
  currentTaskId: null,
  consecutiveFailures: 0,
  wakesDay: null,
  wakesCount: 0,
  pendingSteer: [],
};

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function botStub(id: string) {
  return env.BOT.get(env.BOT.idFromName(id));
}

async function indexBot(
  stub: ReturnType<typeof butler>,
  id: string,
  name: string,
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    new BotsRepo(state.storage.sql).insert({ id, name });
  });
}

describe("butler bot overview", () => {
  it("reads each bot's own state next to its index row", async () => {
    const stub = butler("overview-mixed");
    await indexBot(stub, "b1", "价格哨兵");
    await botStub("b1").init({
      botId: "b1",
      name: "价格哨兵",
      mission: "盯着价格",
      defaultIntervalMs: 3_600_000,
      firstWakeAt: Date.UTC(2030, 0, 1, 10, 0, 0),
    });

    const rows = await stub.botsOverview();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("b1");
    expect(rows[0]!.name).toBe("价格哨兵");
    expect(rows[0]!.unavailable).toBe(false);
    expect(rows[0]!.meta?.status).toBe("active");
    expect(rows[0]!.meta?.mission).toBe("盯着价格");
    expect(rows[0]!.lastRun).toBeNull();
  });

  it("keeps an index row whose bot has no record", async () => {
    const stub = butler("overview-orphan");
    await indexBot(stub, "b9", "孤儿");

    const rows = await stub.botsOverview();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: "b9",
      name: "孤儿",
      createdAt: expect.any(Number),
      meta: null,
      lastRun: null,
      unavailable: false,
    });
  });

  it("returns an empty list when the butler has no bots", async () => {
    await expect(butler("overview-empty").botsOverview()).resolves.toEqual([]);
  });

  it("lists bots in index order", async () => {
    const stub = butler("overview-order");
    await indexBot(stub, "b1", "第一个");
    await indexBot(stub, "b2", "第二个");

    const rows = await stub.botsOverview();

    expect(rows.map((row) => row.id)).toEqual(["b1", "b2"]);
  });

  it("does not return documents in the list", async () => {
    const stub = butler("overview-nodocs");
    await indexBot(stub, "b1", "价格哨兵");
    await botStub("b1").init({
      botId: "b1",
      name: "价格哨兵",
      mission: "盯着价格",
      defaultIntervalMs: DAY_MS,
      firstWakeAt: Date.UTC(2030, 0, 1, 10, 0, 0),
    });

    const rows = await stub.botsOverview();

    expect(rows[0]).not.toHaveProperty("docs");
  });

  it("keeps one broken bot from taking down its neighbours", async () => {
    const healthy = await buildOverviewRow(
      { id: "b1", name: "好的", createdAt: 1 },
      async () => ({ meta: META, docs: [], runs: [] }),
    );
    const broken = await buildOverviewRow(
      { id: "b2", name: "坏的", createdAt: 2 },
      async () => {
        throw new Error("bot DO is gone");
      },
    );

    expect(healthy.meta).not.toBeNull();
    expect(healthy.unavailable).toBe(false);
    expect(broken).toEqual({
      id: "b2",
      name: "坏的",
      createdAt: 2,
      meta: null,
      lastRun: null,
      unavailable: true,
    });
  });

  it("reports a throwing bot as unavailable, not as a failed list", async () => {
    const stub = butler("overview-broken");
    await indexBot(stub, "b1", "好的");
    await botStub("b1").init({
      botId: "b1",
      name: "好的",
      mission: "盯着价格",
      defaultIntervalMs: DAY_MS,
      firstWakeAt: Date.UTC(2030, 0, 1, 10, 0, 0),
    });

    const rows = await stub.botsOverview();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.unavailable).toBe(false);
  });
});
