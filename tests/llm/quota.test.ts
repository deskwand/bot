import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import {
  codexQuota,
  openCodeQuota,
  quotaSecret,
  setQuotaFetch,
} from "../../src/llm/quota";

const NOW = Date.UTC(2030, 0, 1, 0, 0, 0);
const NOW_SEC = NOW / 1000;

beforeEach(() => {
  setClockOverride({
    now: () => NOW,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  setClockOverride(null);
  setQuotaFetch(null);
});

function answering(body: unknown, status = 200): typeof fetch {
  return async () => Response.json(body, { status });
}

const codexBody = {
  plan_type: "team",
  rate_limit: {
    primary_window: {
      used_percent: 9,
      limit_window_seconds: 18000,
      reset_at: NOW_SEC + 3600,
    },
    secondary_window: {
      used_percent: 12.5,
      limit_window_seconds: 604800,
      reset_at: NOW_SEC + 172800,
    },
  },
};

describe("codexQuota", () => {
  it("classifies windows by their length and keeps percent as used", async () => {
    setQuotaFetch(answering(codexBody));

    const result = await codexQuota("access-1", AbortSignal.timeout(1000));

    expect(result).toEqual({
      ok: true,
      quota: {
        provider: "openai-codex",
        plan: "team",
        windows: [
          {
            key: "5h",
            windowSeconds: 18000,
            usedPercent: 9,
            resetsAt: NOW + 3_600_000,
          },
          {
            key: "week",
            windowSeconds: 604800,
            usedPercent: 12.5,
            resetsAt: NOW + 172_800_000,
          },
        ],
        fetchedAt: NOW,
      },
    });
  });

  it("keeps a zero used_percent", async () => {
    setQuotaFetch(
      answering({
        rate_limit: {
          primary_window: {
            used_percent: 0,
            limit_window_seconds: 18000,
            reset_at: NOW_SEC + 60,
          },
        },
      }),
    );

    const result = await codexQuota("access-1", AbortSignal.timeout(1000));

    expect(result.ok && result.quota.windows[0]?.usedPercent).toBe(0);
  });

  it("classifies a weekly window that arrives in the primary slot", async () => {
    setQuotaFetch(
      answering({
        rate_limit: {
          primary_window: {
            used_percent: 40,
            limit_window_seconds: 604800,
            reset_at: NOW_SEC + 60,
          },
          secondary_window: null,
        },
      }),
    );

    const result = await codexQuota("access-1", AbortSignal.timeout(1000));

    expect(result.ok && result.quota.windows).toEqual([
      {
        key: "week",
        windowSeconds: 604800,
        usedPercent: 40,
        resetsAt: NOW + 60_000,
      },
    ]);
  });

  it("falls back to reset_after_seconds", async () => {
    setQuotaFetch(
      answering({
        rate_limit: {
          primary_window: {
            used_percent: 5,
            limit_window_seconds: 18000,
            reset_after_seconds: 120,
          },
        },
      }),
    );

    const result = await codexQuota("access-1", AbortSignal.timeout(1000));

    expect(result.ok && result.quota.windows[0]?.resetsAt).toBe(NOW + 120_000);
  });

  it("sends the originator header and the bearer token", async () => {
    const seen: RequestInit[] = [];
    setQuotaFetch(async (_input, init) => {
      seen.push(init ?? {});
      return Response.json(codexBody);
    });

    await codexQuota("access-1", AbortSignal.timeout(1000));

    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-1");
    expect(headers.originator).toBe("pi");
  });

  it.each([401, 403])("reports %s as rejected", async (status) => {
    setQuotaFetch(answering({}, status));
    expect(await codexQuota("access-1", AbortSignal.timeout(1000))).toEqual({
      ok: false,
      reason: "rejected",
    });
  });

  it("reports a transport failure as unreachable", async () => {
    setQuotaFetch(async () => {
      throw new Error("network down");
    });
    expect(await codexQuota("access-1", AbortSignal.timeout(1000))).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("reports a payload without usable windows as unreachable", async () => {
    setQuotaFetch(answering({ rate_limit: null }));
    expect(await codexQuota("access-1", AbortSignal.timeout(1000))).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});

describe("openCodeQuota", () => {
  it("maps rolling/weekly/monthly and does not scale the percent", async () => {
    setQuotaFetch(
      answering({
        usage: {
          rolling: {
            status: "ok",
            percent: 52,
            resetsAt: new Date(NOW + 60_000).toISOString(),
          },
          weekly: {
            status: "ok",
            percent: 20,
            resetsAt: new Date(NOW + 120_000).toISOString(),
          },
          monthly: {
            status: "ok",
            percent: 61,
            resetsAt: new Date(NOW + 180_000).toISOString(),
          },
        },
      }),
    );

    const result = await openCodeQuota("key-1", AbortSignal.timeout(1000));

    expect(
      result.ok &&
        result.quota.windows.map((window) => [
          window.key,
          window.usedPercent,
        ]),
    ).toEqual([
      ["5h", 52],
      ["week", 20],
      ["month", 61],
    ]);
  });

  it("treats a window that is not ok as exhausted, not as absent", async () => {
    setQuotaFetch(
      answering({
        usage: {
          rolling: {
            status: "limited",
            percent: 100,
            resetsAt: new Date(NOW + 60_000).toISOString(),
          },
          weekly: {
            status: "ok",
            percent: 20,
            resetsAt: new Date(NOW + 120_000).toISOString(),
          },
        },
      }),
    );

    const result = await openCodeQuota("key-1", AbortSignal.timeout(1000));

    expect(result.ok && result.quota.windows).toEqual([
      { key: "5h", usedPercent: 100, resetsAt: NOW + 60_000 },
      { key: "week", usedPercent: 20, resetsAt: NOW + 120_000 },
    ]);
  });

  it("reports a body with no usable window as unreachable", async () => {
    setQuotaFetch(answering({ usage: {} }));
    expect(await openCodeQuota("key-1", AbortSignal.timeout(1000))).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});

describe("quotaSecret", () => {
  it("reads the provider's MODEL_KEY secret and trims it", () => {
    expect(quotaSecret({ MODEL_KEY_OPENCODE_GO: "  k  " }, "opencode-go")).toBe(
      "k",
    );
  });

  it("is undefined when the secret is missing or blank", () => {
    expect(quotaSecret({}, "opencode-go")).toBeUndefined();
    expect(
      quotaSecret({ MODEL_KEY_OPENCODE_GO: "   " }, "opencode-go"),
    ).toBeUndefined();
  });
});
