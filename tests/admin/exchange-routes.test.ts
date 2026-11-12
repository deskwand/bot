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
  return { probe, gateway: createExchangeRoutes({ probe }) };
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

describe("exchange snapshot route", () => {
  const probe = async (): Promise<ExchangeProbeResult> => ({
    ok: true,
    venue: "binance",
    currencies: 0,
  });

  function snapshotRoutes(
    ingest: (body: unknown) => Promise<ExchangeProbeResult>,
  ) {
    return createExchangeRoutes({ probe, ingest });
  }

  it("rejects a body over 2MB", async () => {
    const ingest = vi.fn(async (): Promise<ExchangeProbeResult> => ({
      ok: true,
      venue: "binance",
      currencies: 1,
    }));
    const gateway = snapshotRoutes(ingest);
    const response = await call(gateway, "/admin/exchange/snapshot", {
      body: "x".repeat(2 * 1024 * 1024 + 1),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "EXCHANGE_INVALID" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("measures the 2MB cap in bytes, not characters", async () => {
    const ingest = vi.fn(async (): Promise<ExchangeProbeResult> => ({
      ok: true,
      venue: "binance",
      currencies: 1,
    }));
    const gateway = snapshotRoutes(ingest);
    // 1.1M two-byte characters: under 2M code units, over 2MB on the wire.
    // A stream body carries no content-length, so only the read size counts.
    const bytes = new TextEncoder().encode("é".repeat(1_100_000));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const response = await gateway.fetch(
      new Request("https://example.com/admin/exchange/snapshot", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "EXCHANGE_INVALID" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const ingest = vi.fn(async (): Promise<ExchangeProbeResult> => ({
      ok: true,
      venue: "binance",
      currencies: 1,
    }));
    const gateway = snapshotRoutes(ingest);
    const response = await call(gateway, "/admin/exchange/snapshot", {
      body: "{oops",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "EXCHANGE_INVALID" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("forwards a parsed body and returns the ingest result", async () => {
    const result = {
      ok: true as const,
      venue: "binance",
      currencies: 1,
      total: 10,
    };
    const ingest = vi.fn(async () => result);
    const gateway = snapshotRoutes(ingest);
    const payload = {
      account: "bn-main",
      fetchedAt: 1000,
      responses: [
        { method: "GET", path: "/api/v3/account", status: 200, body: "{}" },
      ],
    };

    const response = await call(gateway, "/admin/exchange/snapshot", {
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(ingest).toHaveBeenCalledWith(payload);
  });

  it("passes a snapshot refusal through as 400", async () => {
    const gateway = snapshotRoutes(async () => ({
      ok: false,
      code: "EXCHANGE_ACCOUNT_UNKNOWN",
      message: "x",
    }));
    const response = await call(gateway, "/admin/exchange/snapshot", {
      body: JSON.stringify({ account: "bn-main", fetchedAt: 1, responses: [] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "EXCHANGE_ACCOUNT_UNKNOWN",
    });
  });

  it("returns 404 when ingest is not wired", async () => {
    const { gateway } = routes();
    const response = await call(gateway, "/admin/exchange/snapshot", {
      body: JSON.stringify({ account: "bn-main", fetchedAt: 1, responses: [] }),
    });
    expect(response.status).toBe(404);
  });
});
