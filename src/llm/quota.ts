/**
 * Subscription quota: what is left of a plan's rolling windows.
 *
 * Both providers answer on undocumented endpoints; this module only knows how
 * to ask and how to normalize the answer. Credentials and caching belong to
 * the life ledger (`src/life/life-do.ts`), which is the only caller.
 *
 * Window names come from `limit_window_seconds` (or OpenCode's own slot names),
 * never from a slot's position: the Codex backend can put a weekly window in
 * `primary_window`. Percentages are always "used", never "left".
 */
import { getClock } from "../butler/notifier";
import { secretNameFor } from "./providers";

export const QUOTA_PROVIDERS: ReadonlySet<string> = new Set([
  "openai-codex",
  "opencode-go",
]);

/** How old a cached number may get before a background refresh. */
export const QUOTA_TTL_MS = 5 * 60_000;

/** One quota request's budget; it runs in the background, never in a turn. */
export const QUOTA_REQUEST_TIMEOUT_MS = 5_000;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** Product names, never copy: not translated. */
export const QUOTA_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  "openai-codex": "Codex",
  "opencode-go": "OpenCode Go",
};

export type QuotaWindowKey = "5h" | "week" | "month";

export type QuotaWindow = {
  /** Display name of the window, not its array position. */
  key: QuotaWindowKey;
  /** Known when the provider tells us (Codex); a calendar month has none. */
  windowSeconds?: number;
  /** 0..100, used. */
  usedPercent: number;
  /** epoch ms */
  resetsAt: number;
};

export type ProviderQuota = {
  provider: string;
  plan?: string;
  windows: QuotaWindow[];
  /** epoch ms of the successful read. */
  fetchedAt: number;
};

export type QuotaFailure =
  | "signed_out"
  | "no_key"
  | "rejected"
  | "unreachable";

export type QuotaResult =
  | { ok: true; quota: ProviderQuota }
  | { ok: false; reason: QuotaFailure };

export type QuotaSnapshot = {
  providers: ProviderQuota[];
  failures: { provider: string; reason: QuotaFailure; at: number }[];
};

export function emptyQuota(): QuotaSnapshot {
  return { providers: [], failures: [] };
}

/** Test-only fetch override, mirroring the clock and model overrides. */
let fetchOverride: typeof fetch | null = null;

export function setQuotaFetch(fn: typeof fetch | null): void {
  fetchOverride = fn;
}

function quotaFetch(): typeof fetch {
  return fetchOverride ?? fetch;
}

/** The API key a key-based quota provider is configured with, if any. */
export function quotaSecret(
  env: Record<string, unknown>,
  provider: string,
): string | undefined {
  const value = env[secretNameFor(provider)];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

type Answer = { status: number; body: unknown };

async function getJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Answer | undefined> {
  try {
    const response = await quotaFetch()(url, { headers, signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  } catch {
    return undefined;
  }
}

function unreachable(): QuotaResult {
  return { ok: false, reason: "unreachable" };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function windowKey(
  seconds: number,
): { key: QuotaWindowKey; windowSeconds?: number } | undefined {
  if (seconds === 18_000) return { key: "5h", windowSeconds: seconds };
  if (seconds === 604_800) return { key: "week", windowSeconds: seconds };
  // A calendar month (28–31 days) is a month without a fixed second count.
  if (seconds >= 2_419_200 && seconds <= 2_678_400) return { key: "month" };
  return undefined;
}

function resetAtMs(value: Record<string, unknown>): number | undefined {
  if (typeof value.reset_at === "number") return value.reset_at * 1000;
  if (typeof value.reset_after_seconds === "number") {
    return getClock().now() + value.reset_after_seconds * 1000;
  }
  return undefined;
}

function codexWindow(raw: unknown): QuotaWindow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const used =
    typeof value.used_percent === "number" ? value.used_percent : undefined;
  const seconds =
    typeof value.limit_window_seconds === "number"
      ? value.limit_window_seconds
      : undefined;
  const classification = seconds === undefined ? undefined : windowKey(seconds);
  const resetsAt = resetAtMs(value);
  if (
    used === undefined ||
    classification === undefined ||
    resetsAt === undefined
  ) {
    return undefined;
  }
  return { ...classification, usedPercent: clampPercent(used), resetsAt };
}

function codexWindows(body: unknown): { windows: QuotaWindow[]; plan?: string } {
  if (typeof body !== "object" || body === null) return { windows: [] };
  const record = body as Record<string, unknown>;
  const plan =
    typeof record.plan_type === "string" ? record.plan_type : undefined;
  const rate = record.rate_limit;
  const windows: QuotaWindow[] = [];
  if (typeof rate === "object" && rate !== null) {
    for (const slot of ["primary_window", "secondary_window"]) {
      const parsed = codexWindow((rate as Record<string, unknown>)[slot]);
      if (parsed !== undefined) windows.push(parsed);
    }
  }
  return plan === undefined ? { windows } : { windows, plan };
}

export async function codexQuota(
  access: string,
  signal: AbortSignal,
): Promise<QuotaResult> {
  const answer = await getJson(
    CODEX_USAGE_URL,
    {
      Authorization: `Bearer ${access}`,
      // Cloudflare rejects an unadorned request from a Worker; not attribution.
      originator: "pi",
      accept: "application/json",
    },
    signal,
  );
  if (answer === undefined) return unreachable();
  if (answer.status === 401 || answer.status === 403) {
    return { ok: false, reason: "rejected" };
  }
  if (answer.status < 200 || answer.status >= 300) return unreachable();
  const { windows, plan } = codexWindows(answer.body);
  if (windows.length === 0) return unreachable();
  return {
    ok: true,
    quota: {
      provider: "openai-codex",
      ...(plan === undefined ? {} : { plan }),
      windows,
      fetchedAt: getClock().now(),
    },
  };
}

const OPENCODE_WINDOWS = [
  ["rolling", "5h"],
  ["weekly", "week"],
  ["monthly", "month"],
] as const;

function openCodeWindows(body: unknown): QuotaWindow[] {
  if (typeof body !== "object" || body === null) return [];
  const usage = (body as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return [];
  const windows: QuotaWindow[] = [];
  for (const [slot, key] of OPENCODE_WINDOWS) {
    const raw = (usage as Record<string, unknown>)[slot];
    if (typeof raw !== "object" || raw === null) continue;
    const value = raw as Record<string, unknown>;
    if (value.status !== "ok") {
      // A window the provider marks as anything but ok is treated as spent,
      // never dropped: dropping it would let a healthy window stand in for an
      // exhausted one and read as "plenty left". Log it so drift is visible.
      console.warn(
        `subscription quota window not ok: opencode-go ${slot} (${String(value.status)})`,
      );
    }
    if (typeof value.percent !== "number") continue;
    if (typeof value.resetsAt !== "string") continue;
    const resetsAt = Date.parse(value.resetsAt);
    if (Number.isNaN(resetsAt)) continue;
    // Documented as a percentage (1 means 1%); see the spec's manual check.
    const used =
      value.status === "ok" ? clampPercent(value.percent) : 100;
    windows.push({ key, usedPercent: used, resetsAt });
  }
  return windows;
}

export async function openCodeQuota(
  apiKey: string,
  signal: AbortSignal,
): Promise<QuotaResult> {
  const answer = await getJson(
    OPENCODE_USAGE_URL,
    { Authorization: `Bearer ${apiKey}`, accept: "application/json" },
    signal,
  );
  if (answer === undefined) return unreachable();
  if (answer.status === 401 || answer.status === 403) {
    return { ok: false, reason: "rejected" };
  }
  if (answer.status < 200 || answer.status >= 300) return unreachable();
  const windows = openCodeWindows(answer.body);
  if (windows.length === 0) return unreachable();
  return {
    ok: true,
    quota: {
      provider: "opencode-go",
      windows,
      fetchedAt: getClock().now(),
    },
  };
}
