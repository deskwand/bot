import { getClock } from "../butler/notifier";
import { t, type Locale, type MessageKey } from "../i18n";
import type { QuotaSnapshot } from "../llm/quota";
import type { HostSnapshot } from "../sandbox/host";
import {
  HOST_MAX_AGE_MS,
  diskPercent,
  hostBands,
  memPercent,
  percentStep,
  type Band,
} from "./host";
import {
  providerLabel,
  quotaBand,
  remainingPercent,
  resetText,
  tightestWindow,
  windowName,
} from "./quota-format";
import type { Tier, Vitals } from "./vitals";

const TIER_NAME: Record<Tier, MessageKey> = {
  ample: "life.prompt.tierName.ample",
  lean: "life.prompt.tierName.lean",
  critical: "life.prompt.tierName.critical",
  dormant: "life.prompt.tierName.dormant",
};

const TIER_BEHAVIOR: Record<Tier, MessageKey> = {
  ample: "life.prompt.tierBehavior.ample",
  lean: "life.prompt.tierBehavior.lean",
  critical: "life.prompt.tierBehavior.critical",
  dormant: "life.prompt.tierBehavior.dormant",
};

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** One money format everywhere: `-$5.00`, `$0.00` for anything rounding to zero. */
export function formatUsd(amount: number): string {
  const fixed = usd(amount);
  if (fixed === "$-0.00") return "$0.00";
  return fixed.startsWith("$-") ? `-$${fixed.slice(2)}` : fixed;
}

/** Whole dollars, so a prompt block does not change with every cent. */
function wholeUsd(amount: number): string {
  const rounded = Math.round(amount);
  if (rounded === 0) return "$0";
  return rounded < 0 ? `-$${Math.abs(rounded)}` : `$${rounded}`;
}

/** The display name of a tier in `locale`. */
export function tierName(locale: Locale, tier: Tier): string {
  return t(locale, TIER_NAME[tier]);
}

/**
 * The life block for a system prompt. The ledger lines (tier, balance, runway,
 * principles) appear only once metabolism has started; the subscription quota
 * line appears whenever there is a window that has not reset yet, because a
 * subscription ceiling is independent of the dollar ledger.
 */
export function lifeBlock(
  locale: Locale,
  vitals: Vitals | null,
  walletValueUsd?: number | null,
  quota?: QuotaSnapshot | null,
  host?: HostSnapshot | null,
): string {
  const lines: string[] = [];
  const ledger = vitals !== null && vitals.metabolismStarted ? vitals : null;
  if (ledger !== null) {
    lines.push(
      t(locale, "life.prompt.tierLabel", {
        tier: tierName(locale, ledger.tier),
        behavior: t(locale, TIER_BEHAVIOR[ledger.tier]),
      }),
    );
    lines.push(
      t(locale, "life.prompt.balance", {
        balance: wholeUsd(ledger.balanceUsd),
      }),
    );
    if (typeof walletValueUsd === "number") {
      lines.push(
        t(locale, "wallet.prompt.value", { value: wholeUsd(walletValueUsd) }),
      );
    }
    lines.push(
      ledger.runwayDays === null
        ? t(locale, "life.prompt.noSpend")
        : Math.floor(ledger.runwayDays) < 1
          ? t(locale, "life.prompt.runwayBelowDay")
          : t(locale, "life.prompt.runway", {
              days: Math.floor(ledger.runwayDays),
            }),
    );
  }
  // A subscription's ceiling is independent of the dollar ledger: report it
  // even when metabolism never started and the tier block stays empty.
  const quotaText = quotaLines(locale, quota);
  lines.push(...quotaText);
  if (ledger === null && quotaText.length > 0) {
    // Without the principles below, a bare number reads like ambient data, and
    // a model with a "delegate it" habit goes looking for an external tool.
    lines.push(t(locale, "life.prompt.quotaNote"));
  }
  // The host is not part of the ledger: report it even when the books are empty.
  lines.push(...hostLines(locale, host));
  if (ledger !== null) {
    if (ledger.unpriced) lines.push(t(locale, "life.prompt.unpriced"));
    lines.push(t(locale, "life.prompt.principleAlive"));
    lines.push(t(locale, "life.prompt.principleOwner"));
  }
  return lines.join("\n");
}

function bandLabel(
  locale: Locale,
  band: Band,
  table: "hostBand" | "hostLoadBand",
): string {
  return t(locale, `life.prompt.${table}.${band}` as MessageKey);
}

/**
 * One coarse line, absent when there is nothing trustworthy to say: no
 * snapshot, a stale one, or a deployment with no host at all.
 */
function hostLines(locale: Locale, host?: HostSnapshot | null): string[] {
  if (host === undefined || host === null) return [];
  if (getClock().now() - host.sampledAt > HOST_MAX_AGE_MS) return [];

  const bands = hostBands(host);
  const parts: string[] = [];

  const disk = diskPercent(host);
  if (bands.disk !== null && disk !== null) {
    parts.push(
      t(locale, "life.prompt.hostDisk", {
        percent: percentStep(disk),
        band: bandLabel(locale, bands.disk, "hostBand"),
      }),
    );
  }

  const mem = memPercent(host);
  if (bands.mem !== null && mem !== null) {
    parts.push(
      t(locale, "life.prompt.hostMem", {
        percent: percentStep(mem),
        band: bandLabel(locale, bands.mem, "hostBand"),
      }),
    );
  }

  // Her own cgroup ceiling is the number that predicts an OOM kill, so it
  // joins the line once it stops being roomy.
  const cgroup = host.mem?.cgroup;
  if (bands.cgroup !== null && bands.cgroup !== "ample" && cgroup !== undefined) {
    parts.push(
      t(locale, "life.prompt.hostOwnMem", {
        percent: percentStep((cgroup.usedBytes / cgroup.limitBytes) * 100),
        band: bandLabel(locale, bands.cgroup, "hostBand"),
      }),
    );
  }

  const cores = host.cpu?.cores;
  if (bands.load !== null && cores !== undefined) {
    parts.push(
      t(locale, "life.prompt.hostLoad", {
        band: bandLabel(locale, bands.load, "hostLoadBand"),
        cores,
      }),
    );
  }

  if (parts.length === 0) return [];

  const lines = [
    t(locale, "life.prompt.hostTitle") +
      parts.join(t(locale, "life.prompt.hostSeparator")),
  ];
  const tight = [bands.disk, bands.mem, bands.load, bands.cgroup].some(
    (band) => band === "lean" || band === "critical",
  );
  if (tight) lines.push(t(locale, "life.prompt.hostTight"));
  return lines;
}

/**
 * One line per provider, naming the window that will throttle first. The
 * percent is rounded to five-point steps so the block does not change on every
 * call and invalidate the prompt prefix cache.
 */
function quotaLines(locale: Locale, quota?: QuotaSnapshot | null): string[] {
  if (quota === undefined || quota === null) return [];
  const now = getClock().now();
  const lines: string[] = [];
  for (const providerQuota of quota.providers) {
    // A window whose reset has passed cannot still hold that percentage: the
    // provider stopped answering and the number outlived its window.
    const live = providerQuota.windows.filter((window) => window.resetsAt > now);
    const window = tightestWindow({ ...providerQuota, windows: live });
    if (window === undefined) continue;
    const remaining = Math.round(remainingPercent(window.usedPercent) / 5) * 5;
    const band = quotaBand(remaining);
    const params = {
      provider: providerLabel(providerQuota.provider),
      window: windowName(locale, window.key),
      band: t(locale, `life.quota.band.${band}` as MessageKey),
      percent: remaining,
      reset: resetText(locale, window.resetsAt, now),
    };
    lines.push(
      providerQuota.plan === undefined
        ? t(locale, "life.prompt.quota", params)
        : t(locale, "life.prompt.quotaWithPlan", {
            ...params,
            plan: providerQuota.plan,
          }),
    );
  }
  return lines;
}
