import { describe, expect, it } from "vitest";
import { createLifeRoutes, type LifeReads } from "../../src/admin/life-routes";
import type { Vitals } from "../../src/life/vitals";

const SAMPLE: Vitals = {
  balanceUsd: 42.5,
  dailySpendUsd: 1.85,
  runwayDays: 23,
  tier: "ample",
  metabolismStarted: true,
  unpriced: false,
  topSources: [{ source: "butler", usd: 6.1 }],
};

function routes(vitals: LifeReads["vitals"] = async () => SAMPLE) {
  return createLifeRoutes({ vitals });
}

function call(
  gateway: ReturnType<typeof createLifeRoutes>,
  init: { method?: string; path?: string } = {},
): Promise<Response> {
  return gateway.fetch(
    new Request(`https://example.com${init.path ?? "/admin/life/vitals"}`, {
      method: init.method ?? "GET",
    }),
  );
}

describe("life vitals route", () => {
  it("returns the vitals as JSON", async () => {
    const response = await call(routes());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SAMPLE);
  });

  it("answers 503 with a code when the read fails", async () => {
    const response = await call(
      routes(async () => {
        throw new Error("ledger down");
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "LIFE_VITALS_FAILED" });
  });

  it("answers other methods and paths with 404", async () => {
    const gateway = routes();
    expect((await call(gateway, { method: "POST" })).status).toBe(404);
    expect((await call(gateway, { path: "/admin/life/other" })).status).toBe(
      404,
    );
  });
});
