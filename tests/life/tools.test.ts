import { describe, expect, it, vi } from "vitest";
import { t } from "../../src/i18n";
import { createLifeTools, type LifeToolDeps } from "../../src/life/tools";
import type { Vitals } from "../../src/life/vitals";

function vitals(overrides: Partial<Vitals> = {}): Vitals {
  return {
    balanceUsd: 13,
    dailySpendUsd: 1,
    runwayDays: 13,
    tier: "lean",
    metabolismStarted: true,
    unpriced: false,
    topSources: [{ source: "butler", usd: 2 }],
    ...overrides,
  };
}

function deps(overrides: Partial<LifeToolDeps> = {}): LifeToolDeps {
  return {
    vitals: vi.fn(async () => vitals()),
    credit: vi.fn(async () => vitals({ balanceUsd: 20 })),
    calibrate: vi.fn(async () =>
      vitals({ balanceUsd: 0, tier: "dormant" }),
    ),
    effectiveModels: vi.fn(async () => ({
      butler: { provider: "test", id: "butler-model" },
      task: { provider: "test", id: "task-model" },
    })),
    locale: "zh",
    ...overrides,
  };
}

async function run(
  tools: ReturnType<typeof createLifeTools>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(args as never, {} as never, {} as never);
}

function text(outcome: {
  output?: { type: string; text?: string }[];
}): string {
  return (outcome.output?.[0] as { text: string }).text;
}

describe("life tools", () => {
  it("credits the books and reports the new balance", async () => {
    const life = deps();
    const result = await run(createLifeTools(life), "life_credit", {
      usd: 7,
    });

    expect(life.credit).toHaveBeenCalledWith(7, "");
    expect(text(result)).toContain("20.00");
  });

  it.each([0, -5, Number.NaN])(
    "rejects a credit of %s without touching the books",
    async (usd) => {
      const life = deps();
      const result = await run(createLifeTools(life), "life_credit", { usd });

      expect(life.credit).not.toHaveBeenCalled();
      expect(text(result)).toBe(t("zh", "life.tool.badAmount"));
    },
  );

  it("accepts a zero and a negative calibration", async () => {
    const life = deps();
    const tools = createLifeTools(life);

    await run(tools, "life_calibrate", { balance_usd: 0 });
    await run(tools, "life_calibrate", { balance_usd: -3 });

    expect(life.calibrate).toHaveBeenNthCalledWith(1, 0, "");
    expect(life.calibrate).toHaveBeenNthCalledWith(2, -3, "");
  });

  it("rejects a non-finite calibration without touching the books", async () => {
    const life = deps();
    const result = await run(createLifeTools(life), "life_calibrate", {
      balance_usd: Number.NaN,
    });

    expect(life.calibrate).not.toHaveBeenCalled();
    expect(text(result)).toBe(t("zh", "life.tool.badAmount"));
  });

  it("reports a failing credit instead of rejecting", async () => {
    const life = deps({
      credit: vi.fn(async () => {
        throw new Error("x");
      }),
    });
    const result = await run(createLifeTools(life), "life_credit", {
      usd: 20,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("x");
  });

  it("reports failing vitals instead of rejecting", async () => {
    const life = deps({
      vitals: vi.fn(async () => {
        throw new Error("x");
      }),
    });
    const result = await run(createLifeTools(life), "life_vitals");

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("x");
  });

  it("reports a failing calibration instead of rejecting", async () => {
    const life = deps({
      calibrate: vi.fn(async () => {
        throw new Error("x");
      }),
    });
    const result = await run(createLifeTools(life), "life_calibrate", {
      balance_usd: 20,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("x");
  });

  it("reports vitals with both roles' effective models", async () => {
    const life = deps();
    const result = await run(createLifeTools(life), "life_vitals");

    const resultText = text(result);
    expect(resultText).toContain("butler-model");
    expect(resultText).toContain("task-model");
    expect(resultText).toContain("13.00");
    expect(resultText).toContain("butler");
  });
});

describe("life_credit remittance", () => {
  function creditTool(life: LifeToolDeps) {
    const tool = createLifeTools(life).find(
      (candidate) => candidate.name === "life_credit",
    );
    if (!tool) throw new Error("missing tool life_credit");
    return tool;
  }

  it("books a settled remittance as earned", async () => {
    const settleRemittance = vi.fn(async () => "settled" as const);
    const life = deps({ settleRemittance });
    const result = await run(createLifeTools(life), "life_credit", {
      usd: 7,
      remittance_id: "rem-1",
    });

    expect(settleRemittance).toHaveBeenCalledWith("rem-1");
    expect(life.credit).toHaveBeenCalledWith(7, "", "earned");
    expect(text(result)).not.toContain(t("zh", "life.tool.remittanceUnknown"));
  });

  it.each([
    ["unknown", "life.tool.remittanceUnknown"],
    ["already", "life.tool.remittanceAlready"],
  ] as const)(
    "books an %s remittance as an owner top-up",
    async (outcome, message) => {
      const settleRemittance = vi.fn(async () => outcome);
      const life = deps({ settleRemittance });
      const result = await run(createLifeTools(life), "life_credit", {
        usd: 7,
        remittance_id: "rem-1",
      });

      expect(life.credit).toHaveBeenCalledWith(7, "");
      expect(text(result)).toContain(t("zh", message));
    },
  );

  it("books an unavailable wallet as an owner top-up", async () => {
    const settleRemittance = vi.fn(async () => {
      throw new Error("offline");
    });
    const life = deps({ settleRemittance });
    const result = await run(createLifeTools(life), "life_credit", {
      usd: 7,
      remittance_id: "rem-1",
    });

    expect(life.credit).toHaveBeenCalledWith(7, "");
    expect(text(result)).toContain(t("zh", "life.tool.remittanceUnavailable"));
  });

  it("rejects a bad amount before touching the remittance", async () => {
    const settleRemittance = vi.fn(async () => "settled" as const);
    const life = deps({ settleRemittance });
    const result = await run(createLifeTools(life), "life_credit", {
      usd: 0,
      remittance_id: "rem-1",
    });

    expect(settleRemittance).not.toHaveBeenCalled();
    expect(life.credit).not.toHaveBeenCalled();
    expect(text(result)).toBe(t("zh", "life.tool.badAmount"));
  });

  it("keeps the old schema when the wallet is not configured", () => {
    const without = creditTool(deps()).parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    const settleRemittance = vi.fn(async () => "settled" as const);
    const withWallet = creditTool(deps({ settleRemittance }))
      .parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };

    expect(Object.keys(without.properties)).toEqual(["usd", "note"]);
    expect(without.required).toEqual(["usd"]);
    expect(Object.keys(withWallet.properties)).toEqual([
      "usd",
      "note",
      "remittance_id",
    ]);
    expect(withWallet.required).toEqual(["usd"]);
  });
});

describe("life_vitals wallet", () => {
  const walletStatus = {
    address: "0x2222222222222222222222222222222222222222" as const,
    holdings: {
      ethWei: 0n,
      tokens: { USDC: 100_000_000n, WETH: 0n, cbBTC: 0n },
      valueUsd: 100,
    },
    pendingRemittance: null,
  };

  it("appends the wallet section when the dependency is present", async () => {
    const life = deps({ wallet: vi.fn(async () => walletStatus) });
    const result = await run(createLifeTools(life), "life_vitals");

    expect(text(result)).toContain(walletStatus.address);
    expect(text(result)).toContain("USDC 100");
    expect(text(result)).toContain("$100.00");
  });

  it("shows the wallet as unavailable when the read returns null", async () => {
    const life = deps({ wallet: vi.fn(async () => null) });
    const result = await run(createLifeTools(life), "life_vitals");

    expect(text(result)).toContain(t("zh", "wallet.vitals.unavailable"));
  });

  it("is byte-for-byte unchanged without the dependency", async () => {
    const result = await run(createLifeTools(deps()), "life_vitals");

    expect(text(result)).toBe(
      [
        "额度：$13.00",
        "日均开销：$1.00",
        "还能活 13.0 天",
        "档位：吃紧",
        "开销来源：butler $2.00",
        "管家模型：test/butler-model",
        "任务模型：test/task-model",
      ].join("\n"),
    );
  });
});
