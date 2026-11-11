import { describe, expect, it, vi } from "vitest";
import {
  createExchangeRoutes,
  type ExchangeProbeResult,
} from "../../src/admin/exchange-routes";

function routes(
  probe = vi.fn<() => Promise<ExchangeProbeResult>>(async () => ({
    ok: true,
    venue: "okx",
    currencies: 2,
  })),
) {
  return { probe, gateway: createExchangeRoutes(probe) };
}

function call(
  gateway: ReturnType<typeof createExchangeRoutes>,
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  return gateway.fetch(
    new Request(`https://example.com${path}`, {
      method: init.method ?? "POST",
      headers: { "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
  );
}

describe("exchange probe route", () => {
  it("returns the probe result for a well-formed request", async () => {
    const { gateway, probe } = routes();
    const response = await call(gateway, "/admin/exchange/probe", {
      body: JSON.stringify({ account: "okx-main" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      venue: "okx",
      currencies: 2,
    });
    expect(probe).toHaveBeenCalledWith("okx-main");
  });

  it("rejects other methods and paths with 404", async () => {
    const { gateway, probe } = routes();
    expect(
      (await call(gateway, "/admin/exchange/probe", { method: "GET" })).status,
    ).toBe(404);
    expect(
      (await call(gateway, "/admin/exchange/other", { body: "{}" })).status,
    ).toBe(404);
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects a body without an account", async () => {
    const { gateway } = routes();
    const response = await call(gateway, "/admin/exchange/probe", {
      body: "{oops",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "EXCHANGE_INVALID" });
  });

  it("passes a refusal through as 400", async () => {
    const { gateway } = routes(
      vi.fn<() => Promise<ExchangeProbeResult>>(async () => ({
        ok: false,
        code: "EXCHANGE_REGION_BLOCKED",
        message: "x",
      })),
    );
    const response = await call(gateway, "/admin/exchange/probe", {
      body: JSON.stringify({ account: "bn-main" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "EXCHANGE_REGION_BLOCKED",
    });
  });
});
