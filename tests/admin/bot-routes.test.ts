import { describe, expect, it } from "vitest";
import {
  BOTS_PATH,
  createBotRoutes,
  type BotReads,
} from "../../src/admin/bot-routes";
import type { BotSnapshot } from "../../src/bot/bot-do";
import type { BotOverviewRow } from "../../src/butler/butler-do";

const META = {
  botId: "b1",
  name: "价格哨兵",
  mission: "盯着价格",
  status: "active" as const,
  nextWakeAt: 1_893_456_000_000,
  defaultIntervalMs: 3_600_000,
  currentTaskId: null,
  consecutiveFailures: 0,
  wakesDay: "2026-11-14",
  wakesCount: 2,
  pendingSteer: [],
};

const ROW: BotOverviewRow = {
  id: "b1",
  name: "价格哨兵",
  createdAt: 1_893_456_000_000,
  meta: META,
  lastRun: {
    taskId: "t1",
    startedAt: 1_893_456_000_000,
    endedAt: 1_893_456_060_000,
    outcome: "completed",
    summary: "已检查",
    note: null,
  },
  unavailable: false,
};

const SNAPSHOT: BotSnapshot = {
  meta: META,
  docs: [{ name: "守则", content: "只做只读查看" }],
  runs: [ROW.lastRun!],
};

function routes(overrides: Partial<BotReads> = {}) {
  return createBotRoutes({
    overview: async () => [ROW],
    snapshot: async () => SNAPSHOT,
    ...overrides,
  });
}

function call(
  gateway: ReturnType<typeof createBotRoutes>,
  path: string,
  method = "GET",
): Promise<Response> {
  return gateway.fetch(new Request(`https://example.com${path}`, { method }));
}

describe("bot routes", () => {
  it("lists the bots under /admin/bots", async () => {
    const response = await call(routes(), BOTS_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bots: [ROW] });
  });

  it("answers an empty index with an empty array, not 404", async () => {
    const response = await call(
      routes({ overview: async () => [] }),
      BOTS_PATH,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bots: [] });
  });

  it("answers 503 with a code when the list read fails", async () => {
    const response = await call(
      routes({
        overview: async () => {
          throw new Error("butler down");
        },
      }),
      BOTS_PATH,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "BOTS_READ_FAILED" });
  });

  it("returns one bot's snapshot", async () => {
    const response = await call(routes(), `${BOTS_PATH}/b1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SNAPSHOT);
  });

  it("answers BOTS_NOT_FOUND when the bot has no record", async () => {
    const response = await call(
      routes({ snapshot: async () => null }),
      `${BOTS_PATH}/b9`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "BOTS_NOT_FOUND" });
  });

  it("answers 503 with a code when the detail read fails", async () => {
    const response = await call(
      routes({
        snapshot: async () => {
          throw new Error("bot down");
        },
      }),
      `${BOTS_PATH}/b1`,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "BOTS_READ_FAILED" });
  });

  it("answers other methods and paths with 404", async () => {
    const gateway = routes();
    expect((await call(gateway, BOTS_PATH, "POST")).status).toBe(404);
    expect((await call(gateway, "/admin/bot")).status).toBe(404);
    expect((await call(gateway, `${BOTS_PATH}/b1/extra`)).status).toBe(404);
    expect((await call(gateway, `${BOTS_PATH}/`)).status).toBe(404);
    // Malformed percent-encoding must be a 404, not a thrown URIError.
    expect((await call(gateway, `${BOTS_PATH}/%E0%A4%A`)).status).toBe(404);
  });
});
