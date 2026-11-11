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
      usd: 20,
    });

    expect(life.credit).toHaveBeenCalledWith(20, "");
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
