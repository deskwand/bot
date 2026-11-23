import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { getClock } from "../butler/notifier";
import { t, type Locale, type MessageKey } from "../i18n";
import type { QuotaSnapshot } from "../llm/quota";
import type { ModelRef, Role } from "../llm/models";
import type { HostRead } from "../sandbox/host";
import { walletStatusLines } from "../wallet/tools";
import type { WalletStatus } from "../wallet/wallet-do";
import { gib } from "./host";
import { formatUsd, tierName } from "./prompt";
import {
  formatPercent,
  providerLabel,
  remainingPercent,
  resetText,
  sortedWindows,
  windowName,
} from "./quota-format";
import type { Vitals } from "./vitals";

const LifeVitals = Type.Object({});

const LifeCreditFields = {
  usd: Type.Number({ description: "US dollars the owner added" }),
  note: Type.Optional(Type.String()),
};

const LifeCredit = Type.Object(LifeCreditFields);

const LifeCreditWithRemittance = Type.Object({
  ...LifeCreditFields,
  remittance_id: Type.Optional(
    Type.String({ description: "The remittance this credit settles" }),
  ),
});

type CreditArgs = {
  usd: number;
  note?: string;
  remittance_id?: string;
};

const LifeCalibrate = Type.Object({
  balance_usd: Type.Number({
    description: "The balance the owner reports, in US dollars",
  }),
  note: Type.Optional(Type.String()),
});

export type LifeToolDeps = {
  vitals(): Promise<Vitals>;
  credit(
    usd: number,
    note: string,
    source?: "owner_topup" | "earned",
  ): Promise<Vitals>;
  settleRemittance?(
    id: string,
  ): Promise<"settled" | "unknown" | "already">;
  calibrate(balanceUsd: number, note: string): Promise<Vitals>;
  /** The chain wallet, or null when it cannot be read. Omitted when unconfigured. */
  wallet?(): Promise<WalletStatus | null>;
  /** Subscription quota, when the deployment uses a provider that reports it. */
  quota?(): Promise<QuotaSnapshot>;
  /** The machine this deployment runs on, or why it cannot be read. */
  host?(): Promise<HostRead>;
  /** The model each role would use right now. */
  effectiveModels(): Promise<Record<Role, ModelRef>>;
  locale: Locale;
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

function vitalsLines(locale: Locale, vitals: Vitals): string[] {
  return [
    t(locale, "life.tool.balance", { balance: formatUsd(vitals.balanceUsd) }),
    t(locale, "life.tool.daily", {
      daily: formatUsd(vitals.dailySpendUsd),
    }),
    vitals.runwayDays === null
      ? t(locale, "life.tool.noSpend")
      : t(locale, "life.tool.runway", {
          days: vitals.runwayDays.toFixed(1),
        }),
    t(locale, "life.tool.tier", { tier: tierName(locale, vitals.tier) }),
  ];
}

/** "just now" / "3 min ago", so a stale number is identified by age. */
function ageText(locale: Locale, at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1
    ? t(locale, "life.tool.quotaAgeNow")
    : t(locale, "life.tool.quotaAgeMinutes", { minutes });
}

/**
 * The exact figures behind the prompt's coarse bands. A provider with no data
 * says why: "not signed in" is not the same as "plenty left".
 */
function quotaLines(locale: Locale, snapshot: QuotaSnapshot): string[] {
  const withData = snapshot.providers.filter(
    (provider) => provider.windows.length > 0,
  );
  if (withData.length === 0 && snapshot.failures.length === 0) return [];
  const now = getClock().now();
  const fetchedAt =
    withData.length === 0
      ? now
      : Math.min(...withData.map((provider) => provider.fetchedAt));
  const lines = [
    t(locale, "life.tool.quotaTitle", {
      age: ageText(locale, fetchedAt, now),
    }),
  ];
  for (const provider of withData) {
    const windows = sortedWindows(provider)
      .map((window) =>
        t(locale, "life.tool.quotaWindow", {
          window: windowName(locale, window.key),
          percent: formatPercent(remainingPercent(window.usedPercent)),
          reset: resetText(locale, window.resetsAt, now),
        }),
      )
      .join(t(locale, "life.tool.quotaSeparator"));
    lines.push(
      provider.plan === undefined
        ? t(locale, "life.tool.quotaLine", {
            provider: providerLabel(provider.provider),
            windows,
          })
        : t(locale, "life.tool.quotaLineWithPlan", {
            provider: providerLabel(provider.provider),
            plan: provider.plan,
            windows,
          }),
    );
  }
  for (const failure of snapshot.failures) {
    const reason = t(
      locale,
      `life.tool.quotaReason.${failure.reason}` as MessageKey,
    );
    const provider = providerLabel(failure.provider);
    lines.push(
      withData.some((entry) => entry.provider === failure.provider)
        ? t(locale, "life.tool.quotaStale", {
            reason,
            age: ageText(locale, failure.at, now),
          })
        : t(locale, "life.tool.quotaUnavailable", { provider, reason }),
    );
  }
  return lines;
}

/** The exact numbers behind the prompt's coarse bands, or why there are none. */
function hostToolLines(locale: Locale, read: HostRead | null): string[] {
  // The distinction that matters to the model is absent / old image / broken;
  // the underlying reason stays in HostRead for tests, not in the text.
  if (read === null) return [t(locale, "life.tool.hostUnavailable")];
  if (read.status === "absent") return [t(locale, "life.tool.hostAbsent")];
  if (read.status === "unsupported") {
    return [t(locale, "life.tool.hostUnsupported")];
  }
  if (read.status === "unavailable") {
    return [t(locale, "life.tool.hostUnavailable")];
  }

  const snapshot = read.snapshot;
  const lines = [
    t(locale, "life.tool.hostTitle", {
      age: ageText(locale, snapshot.sampledAt, getClock().now()),
    }),
  ];

  const cpu = snapshot.cpu;
  if (cpu !== undefined) {
    lines.push(
      cpu.load1 === undefined
        ? t(locale, "life.tool.hostCpu", { cores: cpu.cores })
        : t(locale, "life.tool.hostCpuLoad", {
            cores: cpu.cores,
            load: cpu.load1.toFixed(2),
          }),
    );
  }

  const mem = snapshot.mem;
  if (mem?.totalBytes !== undefined && mem.availableBytes !== undefined) {
    lines.push(
      t(locale, "life.tool.hostMem", {
        available: gib(mem.availableBytes),
        total: gib(mem.totalBytes),
        percent: Math.round((mem.availableBytes / mem.totalBytes) * 100),
      }),
    );
  }
  if (mem?.cgroup !== undefined) {
    lines.push(
      t(locale, "life.tool.hostCgroup", {
        limit: gib(mem.cgroup.limitBytes),
        used: gib(mem.cgroup.usedBytes),
        percent: Math.round(
          (mem.cgroup.usedBytes / mem.cgroup.limitBytes) * 100,
        ),
      }),
    );
  }

  for (const disk of snapshot.disk ?? []) {
    lines.push(
      t(locale, "life.tool.hostDisk", {
        path: disk.path,
        free: gib(disk.freeBytes),
        total: gib(disk.totalBytes),
        percent: Math.round((disk.freeBytes / disk.totalBytes) * 100),
      }),
    );
  }

  return lines;
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
      "Show the life ledger: balance, daily spend, runway, tier, the model each role is using right now, how much subscription quota is left (each window with its reset time), and the host machine's CPU, memory and disk.",
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
                  .map((entry) => `${entry.source} ${formatUsd(entry.usd)}`)
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
        if (deps.quota !== undefined) {
          let quota: QuotaSnapshot | null = null;
          try {
            quota = await deps.quota();
          } catch {
            quota = null;
          }
          if (quota !== null) lines.push(...quotaLines(locale, quota));
        }
        if (deps.host !== undefined) {
          let read: HostRead | null = null;
          try {
            read = await deps.host();
          } catch {
            read = null;
          }
          lines.push(...hostToolLines(locale, read));
        }
        if (deps.wallet !== undefined) {
          let wallet: WalletStatus | null = null;
          try {
            wallet = await deps.wallet();
          } catch {
            wallet = null;
          }
          lines.push(
            wallet === null
              ? t(locale, "wallet.vitals.unavailable")
              : walletStatusLines(locale, wallet).join("\n"),
          );
        }
        return output(lines.join("\n"));
      } catch (error) {
        return failed(error);
      }
    },
  };

  const creditTool: ToolRegistration = {
    name: "life_credit",
    description:
      deps.settleRemittance === undefined
        ? "Record credit the owner added to the deployment, in US dollars."
        : "Record credit the owner added to the deployment, in US dollars. Pass remittance_id from wallet_status when the owner confirms a remittance arrived.",
    parameters:
      deps.settleRemittance === undefined
        ? LifeCredit
        : LifeCreditWithRemittance,
    async execute(args) {
      const { usd, note, remittance_id } = args as CreditArgs;
      if (!Number.isFinite(usd) || usd <= 0) {
        return errorOutput(t(locale, "life.tool.badAmount"));
      }

      let source: "owner_topup" | "earned" = "owner_topup";
      let extra: string | null = null;
      if (remittance_id !== undefined && deps.settleRemittance !== undefined) {
        try {
          const outcome = await deps.settleRemittance(remittance_id);
          if (outcome === "settled") {
            source = "earned";
          } else {
            extra = t(
              locale,
              outcome === "unknown"
                ? "life.tool.remittanceUnknown"
                : "life.tool.remittanceAlready",
            );
          }
        } catch {
          extra = t(locale, "life.tool.remittanceUnavailable");
        }
      }

      try {
        const vitals =
          source === "earned"
            ? await deps.credit(usd, note ?? "", "earned")
            : await deps.credit(usd, note ?? "");
        const credited = t(locale, "life.tool.credit", {
          amount: formatUsd(usd),
          balance: formatUsd(vitals.balanceUsd),
          tier: tierName(locale, vitals.tier),
        });
        return output(extra === null ? credited : `${credited}\n${extra}`);
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
            amount: formatUsd(balance_usd),
            balance: formatUsd(vitals.balanceUsd),
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
