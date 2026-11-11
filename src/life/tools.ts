import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { t, type Locale, type MessageKey } from "../i18n";
import type { ModelRef, Role } from "../llm/models";
import type { Tier, Vitals } from "./vitals";

const LifeVitals = Type.Object({});

const LifeCredit = Type.Object({
  usd: Type.Number({ description: "US dollars the owner added" }),
  note: Type.Optional(Type.String()),
});

const LifeCalibrate = Type.Object({
  balance_usd: Type.Number({
    description: "The balance the owner reports, in US dollars",
  }),
  note: Type.Optional(Type.String()),
});

export type LifeToolDeps = {
  vitals(): Promise<Vitals>;
  credit(usd: number, note: string): Promise<Vitals>;
  calibrate(balanceUsd: number, note: string): Promise<Vitals>;
  /** The model each role would use right now. */
  effectiveModels(): Promise<Record<Role, ModelRef>>;
  locale: Locale;
};

const TIER_NAME: Record<Tier, MessageKey> = {
  ample: "life.prompt.tierName.ample",
  lean: "life.prompt.tierName.lean",
  critical: "life.prompt.tierName.critical",
  dormant: "life.prompt.tierName.dormant",
};

function output(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

function errorOutput(text: string) {
  return { output: [{ type: "text" as const, text }], isError: true };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function tierName(locale: Locale, tier: Tier): string {
  return t(locale, TIER_NAME[tier]);
}

function vitalsLines(locale: Locale, vitals: Vitals): string[] {
  return [
    t(locale, "life.tool.balance", { balance: money(vitals.balanceUsd) }),
    t(locale, "life.tool.daily", {
      daily: money(vitals.dailySpendUsd),
    }),
    vitals.runwayDays === null
      ? t(locale, "life.tool.noSpend")
      : t(locale, "life.tool.runway", {
          days: vitals.runwayDays.toFixed(1),
        }),
    t(locale, "life.tool.tier", { tier: tierName(locale, vitals.tier) }),
  ];
}

function modelLabel(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

/**
 * The owner's door to the life ledger. Every tool answers the model with text
 * and never throws: a failure is reported, never allowed to stop the reply.
 */
export function createLifeTools(deps: LifeToolDeps): ToolRegistration[] {
  const locale = deps.locale;
  const failed = (error: unknown) =>
    errorOutput(t(locale, "life.tool.failed", { error: errorText(error) }));

  const vitalsTool: ToolRegistration<typeof LifeVitals> = {
    name: "life_vitals",
    description:
      "Show the life ledger: balance, daily spend, runway, tier and the model each role is using right now.",
    parameters: LifeVitals,
    replay: "safe",
    async execute() {
      try {
        const vitals = await deps.vitals();
        const models = await deps.effectiveModels();
        const lines = vitalsLines(locale, vitals);
        lines.push(
          vitals.topSources.length === 0
            ? t(locale, "life.tool.noSources")
            : t(locale, "life.tool.topSources", {
                sources: vitals.topSources
                  .map((entry) => `${entry.source} ${money(entry.usd)}`)
                  .join(", "),
              }),
        );
        if (vitals.unpriced) lines.push(t(locale, "life.tool.unpriced"));
        lines.push(
          t(locale, "life.tool.models", {
            butler: modelLabel(models.butler),
            task: modelLabel(models.task),
          }),
        );
        return output(lines.join("\n"));
      } catch (error) {
        return failed(error);
      }
    },
  };

  const creditTool: ToolRegistration<typeof LifeCredit> = {
    name: "life_credit",
    description:
      "Record credit the owner added to the deployment, in US dollars.",
    parameters: LifeCredit,
    async execute({ usd, note }) {
      if (!Number.isFinite(usd) || usd <= 0) {
        return errorOutput(t(locale, "life.tool.badAmount"));
      }
      try {
        const vitals = await deps.credit(usd, note ?? "");
        return output(
          t(locale, "life.tool.credit", {
            amount: money(usd),
            balance: money(vitals.balanceUsd),
            tier: tierName(locale, vitals.tier),
          }),
        );
      } catch (error) {
        return failed(error);
      }
    },
  };

  const calibrateTool: ToolRegistration<typeof LifeCalibrate> = {
    name: "life_calibrate",
    description:
      "Set the ledger balance to the figure the owner reports, in US dollars.",
    parameters: LifeCalibrate,
    async execute({ balance_usd, note }) {
      if (!Number.isFinite(balance_usd)) {
        return errorOutput(t(locale, "life.tool.badAmount"));
      }
      try {
        const vitals = await deps.calibrate(balance_usd, note ?? "");
        return output(
          t(locale, "life.tool.calibrate", {
            amount: money(balance_usd),
            balance: money(vitals.balanceUsd),
            tier: tierName(locale, vitals.tier),
          }),
        );
      } catch (error) {
        return failed(error);
      }
    },
  };

  return [vitalsTool, creditTool, calibrateTool];
}
