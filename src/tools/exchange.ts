import { Type } from "@earendil-works/pi-ai";
import type {
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { t, type Locale, type MessageKey } from "../i18n";
import { cacheKey, type SnapshotCache } from "../exchange/cache";
import {
  BUCKETS,
  ExchangeError,
  type ExchangeAccount,
  type Include,
  type VenueAdapter,
  type VenueId,
  type VenuePosition,
  type VenueSnapshot,
} from "../exchange/types";

const MAX_ACCOUNTS = 8;
const MAX_OUTPUT_CHARS = 20_000;
const CONCURRENCY = 3;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_MIN_VALUE = 1;

const ExchangeAssets = Type.Object({
  account: Type.Optional(Type.String()),
  venue: Type.Optional(Type.String({ enum: ["okx", "binance"] })),
  include: Type.Optional(Type.Array(Type.String())),
  minValue: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

export type ExchangeToolDeps = {
  locale: () => Locale;
  adapters: Record<VenueId, VenueAdapter>;
  cache: SnapshotCache;
};

function ok(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }] };
}

function fail(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }], isError: true };
}

function errorText(locale: Locale, error: unknown): string {
  const bucket = error instanceof ExchangeError ? error.bucket : "network";
  return t(locale, `exchange.error.${bucket}` as MessageKey);
}

export function exchangeProgressText(args: unknown, locale: Locale): string {
  const account = (args ?? {}) as { account?: unknown };
  if (typeof account.account !== "string" || account.account === "") {
    return t(locale, "exchange.progress.all");
  }
  return t(locale, "exchange.progress.assets", { account: account.account });
}

const ALL_INCLUDES: readonly Include[] = [...BUCKETS, "positions"];

/** Unknown bucket names are ignored: the model may invent one. */
function requestedIncludes(value: unknown): Include[] {
  if (!Array.isArray(value)) return [...ALL_INCLUDES];
  const allowed = new Set<string>(ALL_INCLUDES);
  const picked: Include[] = [];
  for (const item of value) {
    if (
      typeof item === "string" &&
      allowed.has(item) &&
      !picked.includes(item as Include)
    ) {
      picked.push(item as Include);
    }
  }
  return picked.length === 0 ? [...ALL_INCLUDES] : picked;
}

/**
 * OKX keeps margin inside the trading account, so a request for margin reads
 * that account instead of returning an empty result.
 */
function wantedFor(venue: VenueId, include: readonly Include[]): Include[] {
  const out: Include[] = [];
  for (const item of include) {
    const mapped: Include = item === "margin" && venue === "okx" ? "spot" : item;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

function thousands(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  const [whole, fraction] = fixed.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Sub-cent amounts keep their digits: a dust holding must not read as zero. */
function amountText(value: number): string {
  if (value >= 1000) return thousands(value, 2);
  const text = value.toPrecision(6);
  return text.includes("e") ? value.toFixed(8) : String(Number(text));
}

function valueText(value: number): string {
  if (value !== 0 && Math.abs(value) < 0.01) return value.toPrecision(3);
  const text = thousands(value, 2);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

function label(locale: Locale, key: string): string {
  return t(locale, `exchange.${key}` as MessageKey);
}

function positionLine(position: VenuePosition, locale: Locale): string {
  const side = label(
    locale,
    position.side === "long" ? "position.long" : "position.short",
  );
  const parts = [`${position.instrument} ${side} ${amountText(position.qty)}`];
  if (position.entry !== undefined) {
    parts.push(`${label(locale, "position.entry")} ${valueText(position.entry)}`);
  }
  if (position.mark !== undefined) {
    parts.push(`${label(locale, "position.mark")} ${valueText(position.mark)}`);
  }
  if (position.upl !== undefined) {
    const sign = position.upl >= 0 ? "+" : "";
    parts.push(
      `${label(locale, "position.upl")} ${sign}${valueText(position.upl)}`,
    );
  }
  if (position.liq !== undefined) {
    parts.push(`${label(locale, "position.liq")} ${valueText(position.liq)}`);
  }
  return parts.join(" · ");
}

function formatAccount(
  account: ExchangeAccount,
  snapshot: VenueSnapshot,
  locale: Locale,
  options: { minValue: number; limit: number; mergedMargin: boolean },
): string[] {
  const { minValue, limit } = options;
  const lines: string[] = [`## ${account.label}（${account.id}）`];
  if (snapshot.total !== undefined) {
    lines.push(
      t(locale, "exchange.result.accountTotal", {
        total: valueText(snapshot.total),
      }),
    );
  }

  let printed = false;

  for (const bucket of snapshot.buckets) {
    if (bucket.balances.length === 0) continue;
    const shown: string[] = [];
    let foldedCount = 0;
    let foldedValue = 0;
    let hidden = 0;
    const sorted = [...bucket.balances].sort(
      (left, right) => (right.value ?? -1) - (left.value ?? -1),
    );
    for (const balance of sorted) {
      if (balance.value !== undefined && balance.value < minValue) {
        foldedCount += 1;
        foldedValue += balance.value;
        continue;
      }
      if (shown.length >= limit) {
        hidden += 1;
        continue;
      }
      shown.push(
        balance.value === undefined
          ? // No price on this venue for this currency: show the amount,
            // never a fake value.
            `${balance.ccy} ${amountText(balance.amount)}`
          : `${balance.ccy} ${amountText(balance.amount)} ≈ ${valueText(
              balance.value,
            )}`,
      );
    }
    if (foldedCount > 0) {
      shown.push(
        t(locale, "exchange.result.folded", {
          count: foldedCount,
          min: valueText(minValue),
          total: valueText(foldedValue),
        }),
      );
    }
    if (hidden > 0) {
      shown.push(t(locale, "exchange.result.truncated", { count: hidden }));
    }
    if (shown.length === 0) continue;
    const name = label(locale, `bucket.${bucket.bucket}`);
    const head =
      bucket.value === undefined ? name : `${name} ${valueText(bucket.value)}`;
    lines.push(`- ${head}：${shown.join("；")}`);
    printed = true;
  }

  if (options.mergedMargin) {
    lines.push(`- ${t(locale, "exchange.result.merged")}`);
  }

  if (snapshot.positions.length > 0) {
    const shown = snapshot.positions
      .slice(0, limit)
      .map((position) => positionLine(position, locale));
    lines.push(`- ${t(locale, "exchange.result.positions")}：${shown.join("；")}`);
    printed = true;
  }

  for (const item of snapshot.degraded) {
    lines.push(
      t(locale, "exchange.result.degraded", {
        part: label(locale, `part.${item.part}`),
        reason: t(locale, `exchange.error.${item.reason}` as MessageKey),
      }),
    );
  }

  if (!printed) lines.push(`- ${t(locale, "exchange.result.empty")}`);
  return lines;
}

type Outcome =
  | {
      account: ExchangeAccount;
      snapshot: VenueSnapshot;
      ageMs: number;
      fromCache: boolean;
    }
  | { account: ExchangeAccount; error: unknown };

export function exchangeAssetsTool(
  accounts: ExchangeAccount[],
  deps: ExchangeToolDeps,
): ToolRegistration<typeof ExchangeAssets> {
  return {
    name: "exchange_assets",
    description:
      "Read-only balances and open positions for the owner's crypto exchange accounts " +
      "(OKX, Binance). Returns spot, funding, margin, futures and earn buckets valued " +
      "in USDT, plus positions with unrealized PnL and liquidation price. Values are " +
      "estimates from live tickers. Never places, cancels, transfers or withdraws.",
    parameters: ExchangeAssets,
    replay: "safe",
    async execute(args, _api, context): Promise<ToolExecutionResult> {
      const locale = deps.locale();
      const include = requestedIncludes(args.include);

      let selected: ExchangeAccount[];
      if (args.account !== undefined && args.account !== "") {
        const one = accounts.find((entry) => entry.id === args.account);
        if (one === undefined) {
          return fail(t(locale, "exchange.error.account", { id: args.account }));
        }
        selected = [one];
      } else {
        selected = accounts.filter(
          (entry) => args.venue === undefined || entry.venue === args.venue,
        );
      }
      if (selected.length === 0) {
        return fail(
          t(locale, "exchange.error.account", { id: args.account ?? "" }),
        );
      }

      const capped = selected.slice(0, MAX_ACCOUNTS);
      const skippedAccounts = selected.slice(MAX_ACCOUNTS);
      const minValue =
        args.minValue !== undefined && args.minValue >= 0
          ? args.minValue
          : DEFAULT_MIN_VALUE;
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, Math.trunc(args.limit ?? DEFAULT_LIMIT)),
      );

      const outcomes: Outcome[] = new Array(capped.length);
      let cursor = 0;
      async function worker(): Promise<void> {
        while (cursor < capped.length) {
          const index = cursor++;
          const account = capped[index]!;
          const adapter = deps.adapters[account.venue];
          const wanted = wantedFor(account.venue, include).filter(
            (item) => item === "positions" || adapter.supports.includes(item),
          );
          // The cache key follows what was actually requested, so a bucket the
          // venue was never asked about cannot be served as "nothing there".
          const key = cacheKey(account.id, wanted);
          const hit = deps.cache.get(key);
          if (hit !== undefined) {
            outcomes[index] = {
              account,
              snapshot: hit.snapshot,
              ageMs: hit.ageMs,
              fromCache: true,
            };
            continue;
          }
          try {
            const snapshot = await adapter.fetch(
              account,
              { include: wanted },
              context.abortSignal,
            );
            deps.cache.set(key, snapshot);
            outcomes[index] = { account, snapshot, ageMs: 0, fromCache: false };
          } catch (error) {
            if (context.abortSignal?.aborted) throw error;
            outcomes[index] = { account, error };
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, capped.length) }, () =>
          worker(),
        ),
      );

      const succeeded = outcomes.filter(
        (item): item is Extract<Outcome, { snapshot: VenueSnapshot }> =>
          "snapshot" in item,
      );
      if (succeeded.length === 0) {
        const first = outcomes[0]!;
        const reason = "error" in first ? errorText(locale, first.error) : "";
        return fail(
          `${reason}\n${t(locale, "exchange.result.allFailed", {
            count: outcomes.length,
          })}`,
        );
      }

      const head: string[] = [];
      if (succeeded.length > 1) {
        const total = succeeded.reduce(
          (sum, item) => sum + (item.snapshot.total ?? 0),
          0,
        );
        const each = succeeded
          .map(
            (item) =>
              `${item.account.venue.toUpperCase()} ${valueText(
                item.snapshot.total ?? 0,
              )}`,
          )
          .join(" · ");
        head.push(
          t(locale, "exchange.result.total", {
            total: valueText(total),
            parts: each,
          }),
        );
      }
      const cached = succeeded.filter((item) => item.fromCache);
      if (cached.length > 0) {
        const oldest = Math.max(...cached.map((item) => item.ageMs));
        head.push(
          t(locale, "exchange.result.cached", {
            seconds: Math.round(oldest / 1000),
          }),
        );
      }

      const blocks: string[][] = outcomes.map((outcome) =>
        "error" in outcome
          ? [
              t(locale, "exchange.result.skipped", {
                account: outcome.account.label,
                reason: errorText(locale, outcome.error),
              }),
            ]
          : formatAccount(outcome.account, outcome.snapshot, locale, {
              minValue,
              limit,
              mergedMargin:
                include.includes("margin") && outcome.account.venue === "okx",
            }),
      );
      if (skippedAccounts.length > 0) {
        blocks.push([
          t(locale, "exchange.result.overCap", {
            count: skippedAccounts.length,
            list: skippedAccounts.map((entry) => entry.id).join("、"),
          }),
        ]);
      }

      // Trim by whole accounts, so a line is never cut in half and the count of
      // what was dropped is exact.
      const tail = (count: number): string =>
        t(locale, "exchange.result.accountsLeft", { count });

      let text = head.join("\n");
      let dropped = 0;
      for (let index = 0; index < blocks.length; index += 1) {
        const chunk = blocks[index]!.join("\n");
        const joined = text === "" ? chunk : `${text}\n\n${chunk}`;
        if (joined.length > MAX_OUTPUT_CHARS) {
          dropped = blocks.length - index;
          break;
        }
        text = joined;
      }
      if (dropped > 0) text = `${text}\n${tail(dropped)}`;
      return ok(text);
    },
  };
}
