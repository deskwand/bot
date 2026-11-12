import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { t, type Locale, type MessageKey } from "../i18n";
import { CHAINS, type Token } from "./chain";
import type {
  HistoryRow,
  SwapResult,
  WalletDO,
  WalletStatus,
} from "./wallet-do";
import { txUrl } from "./wallet-do";
import { MAX_PRICE_HOURS } from "./guard";
import type { PriceSeries } from "./store";
import { formatUsd } from "../life/prompt";

const WalletStatusParams = Type.Object({});
const MarketPricesParams = Type.Object({
  hours: Type.Optional(Type.Number()),
});
const SwapParams = Type.Object({
  sell: Type.Union([
    Type.Literal("USDC"),
    Type.Literal("WETH"),
    Type.Literal("cbBTC"),
  ]),
  buy: Type.Union([
    Type.Literal("USDC"),
    Type.Literal("WETH"),
    Type.Literal("cbBTC"),
  ]),
  amount: Type.String(),
});
const HistoryParams = Type.Object({
  limit: Type.Optional(Type.Number()),
});

/** The wallet RPCs an earner bot may call. */
export type WalletEarnerPort = Pick<
  WalletDO,
  "status" | "prices" | "swap" | "history"
>;

/** Base-unit amounts rendered without losing the token's own decimals. */
function amountText(base: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = base / divisor;
  const fraction = base % divisor;
  if (fraction === 0n) return whole.toString();
  const digits = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${digits}`;
}

function tokenDecimals(token: Token): number {
  return CHAINS.base.tokens[token]?.decimals ?? 0;
}

function output(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

function errorOutput(text: string) {
  return { output: [{ type: "text" as const, text }], isError: true };
}

function clampInt(value: unknown, fallback: number, low: number, high: number): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(high, Math.max(low, parsed));
}

/** `MM-DD HH:00` in UTC, stable regardless of the worker's timezone. */
function hourText(at: number): string {
  return new Date(at).toISOString().slice(5, 16).replace("T", " ");
}

/** A signed dollar delta; `null` means the value was never recorded. */
function deltaText(value: number | null): string {
  if (value === null) return "—";
  const text = formatUsd(value);
  return value > 0 ? `+${text}` : text;
}

function percentText(from: number, to: number): string {
  if (from === 0) return "0.00%";
  const pct = ((to - from) / from) * 100;
  if (Number.isFinite(pct) === false) return "0.00%";
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}

function priceLines(locale: Locale, hours: number, series: PriceSeries[]): string[] {
  const lines: string[] = [t(locale, "wallet.prices.title", { hours })];
  let any = false;
  for (const item of series) {
    if (item.points.length === 0) continue;
    any = true;
    const first = item.points[0]?.usd ?? 0;
    const latest = item.points[item.points.length - 1]?.usd ?? 0;
    const prices = item.points.map((point) => point.usd);
    lines.push(
      t(locale, "wallet.prices.line", {
        token: item.token,
        latest: formatUsd(latest),
        high: formatUsd(Math.max(...prices)),
        low: formatUsd(Math.min(...prices)),
        change: percentText(first, latest),
      }),
    );
    const sampled = item.points.filter((_, index) => index % 4 === 0);
    const last = item.points[item.points.length - 1];
    if (last !== undefined && sampled[sampled.length - 1] !== last) {
      sampled.push(last);
    }
    lines.push(
      t(locale, "wallet.prices.series", {
        token: item.token,
        points: sampled
          .map((point) => `${hourText(point.at)} ${formatUsd(point.usd)}`)
          .join(" → "),
      }),
    );
  }
  if (!any) lines.push(t(locale, "wallet.prices.empty"));
  return lines;
}

function historyLine(locale: Locale, row: HistoryRow): string {
  const status = t(
    locale,
    `wallet.history.status.${row.status}` as MessageKey,
  );
  const tx =
    row.txHash === null
      ? t(locale, "wallet.history.noTx")
      : t(locale, "wallet.history.tx", { txUrl: txUrl(row.txHash) });
  if (row.kind === "remit") {
    return t(locale, "wallet.history.remit", {
      at: hourText(row.at),
      id: row.id,
      amount: amountText(BigInt(row.amount), 6),
      status,
      tx,
    });
  }
  const sell = row.sell ?? "USDC";
  const buy = row.buy ?? "USDC";
  return t(locale, "wallet.history.swap", {
    at: hourText(row.at),
    id: row.id,
    amount: amountText(BigInt(row.amount), tokenDecimals(sell)),
    sell,
    buy,
    delta: deltaText(row.valueDeltaUsd),
    status,
    tx,
  });
}

function swapOkText(
  locale: Locale,
  result: Extract<SwapResult, { ok: true }>,
  buy: Token,
): string {
  return t(locale, "wallet.swap.ok", {
    amountOut: amountText(BigInt(result.amountOut), tokenDecimals(buy)),
    buy,
    before: formatUsd(result.valueBefore),
    after: result.valueAfter === null ? "—" : formatUsd(result.valueAfter),
    txUrl: txUrl(result.txHash),
  });
}

/** The wallet as the owner reads it: address, holdings, value and pending. */
export function walletStatusLines(
  locale: Locale,
  status: WalletStatus,
): string[] {
  const holdings = (
    Object.entries(status.holdings.tokens) as [Token, bigint][]
  )
    .filter(([, balance]) => balance > 0n)
    .map(([token, balance]) =>
      t(locale, "wallet.status.holding", {
        token,
        amount: amountText(balance, tokenDecimals(token)),
      }),
    );

  const pending = status.pendingRemittance;
  return [
    t(locale, "wallet.status.title"),
    t(locale, "wallet.status.address", { address: status.address }),
    holdings.length === 0
      ? t(locale, "wallet.status.noHoldings")
      : t(locale, "wallet.status.holdings", {
          holdings: holdings.join(locale === "zh" ? "、" : ", "),
        }),
    t(locale, "wallet.status.value", {
      value: formatUsd(status.holdings.valueUsd),
    }),
    t(
      locale,
      status.breaker.tripped
        ? "wallet.status.breaker"
        : "wallet.status.breakerOk",
      { loss: formatUsd(status.breaker.lossUsd) },
    ),
    pending === null
      ? t(locale, "wallet.status.noPending")
      : t(locale, "wallet.status.pending", {
          id: pending.id,
          usdc: formatUsd(pending.usdc),
        }),
  ];
}

/**
 * The read-only wallet door. It never moves money; the only write it enables
 * is the owner telling the butler a remittance arrived.
 */
export function createWalletTools(deps: {
  status(): Promise<WalletStatus>;
  locale: Locale;
}): ToolRegistration[] {
  const locale = deps.locale;

  const statusTool: ToolRegistration<typeof WalletStatusParams> = {
    name: "wallet_status",
    description:
      "Show the wallet address, token holdings, total value and any pending remittance. When the owner says a remittance arrived, pass the id of that pending remittance to life_credit as remittance_id.",
    parameters: WalletStatusParams,
    replay: "safe",
    async execute() {
      try {
        return output(walletStatusLines(locale, await deps.status()).join("\n"));
      } catch (error) {
        // A chain error can carry the RPC URL (and its key): never echo it.
        console.warn(
          "wallet: status read failed",
          error instanceof Error ? error.constructor.name : "Error",
        );
        return errorOutput(t(locale, "wallet.vitals.unavailable"));
      }
    },
  };

  return [statusTool];
}

function warn(scope: string, error: unknown): void {
  console.warn(
    `wallet: ${scope} failed`,
    error instanceof Error ? error.constructor.name : "Error",
  );
}

/**
 * The earner bot's wallet. It can read balances, prices and history, and send
 * one swap at a time. The rules live in the wallet; this layer only translates.
 */
export function createEarnerTools(deps: {
  wallet(): WalletEarnerPort;
  locale: Locale;
}): ToolRegistration[] {
  const locale = deps.locale;

  const balancesTool: ToolRegistration<typeof WalletStatusParams> = {
    name: "wallet_balances",
    description:
      "Show the wallet address, token balances, total value in USD, the breaker state and any pending remittance.",
    parameters: WalletStatusParams,
    replay: "safe",
    async execute() {
      try {
        return output(
          walletStatusLines(locale, await deps.wallet().status()).join("\n"),
        );
      } catch (error) {
        warn("balances read", error);
        return errorOutput(t(locale, "wallet.vitals.unavailable"));
      }
    },
  };

  const pricesTool: ToolRegistration<typeof MarketPricesParams> = {
    name: "market_prices",
    description:
      "Show the hourly prices of WETH and cbBTC in USD: latest, high, low and change over the window, followed by a sample every four hours. Use it before deciding whether to trade. hours defaults to 24 and is capped at 168.",
    parameters: MarketPricesParams,
    replay: "safe",
    async execute(raw) {
      const args = raw as { hours?: number };
      const hours = clampInt(args.hours, 24, 1, MAX_PRICE_HOURS);
      try {
        return output(
          priceLines(locale, hours, await deps.wallet().prices(hours)).join(
            "\n",
          ),
        );
      } catch (error) {
        warn("prices read", error);
        return errorOutput(t(locale, "wallet.vitals.unavailable"));
      }
    },
  };

  const swapTool: ToolRegistration<typeof SwapParams> = {
    name: "wallet_swap",
    description:
      "Swap one whitelisted token for another through the wallet. sell and buy are USDC, WETH or cbBTC; amount is a decimal amount of the sold token, for example \"10\". Every risk limit is enforced by the wallet; when it refuses, the reason is returned. A swap that is already in flight must never be retried.",
    parameters: SwapParams,
    async execute(raw) {
      const args = raw as { sell: Token; buy: Token; amount: string };
      try {
        const result = await deps
          .wallet()
          .swap(args.sell, args.buy, args.amount);
        if (!result.ok) {
          return errorOutput(t(locale, result.reason as MessageKey));
        }
        return output(swapOkText(locale, result, args.buy));
      } catch (error) {
        warn("swap", error);
        return errorOutput(t(locale, "wallet.swap.rpc"));
      }
    },
  };

  const historyTool: ToolRegistration<typeof HistoryParams> = {
    name: "wallet_history",
    description:
      "List recent swaps and remittances, newest first, with the amount and the change in the wallet's value. limit defaults to 10 and is capped at 50.",
    parameters: HistoryParams,
    replay: "safe",
    async execute(raw) {
      const args = raw as { limit?: number };
      const limit = clampInt(args.limit, 10, 1, 50);
      try {
        const rows = await deps.wallet().history(limit);
        if (rows.length === 0) {
          return output(t(locale, "wallet.history.empty"));
        }
        return output(rows.map((row) => historyLine(locale, row)).join("\n"));
      } catch (error) {
        warn("history read", error);
        return errorOutput(t(locale, "wallet.vitals.unavailable"));
      }
    },
  };

  return [balancesTool, pricesTool, swapTool, historyTool];
}

/** The owner's switch for lifting the breaker; the bot never gets it. */
export function createWalletResumeTool(deps: {
  resume(): Promise<void>;
  locale: Locale;
}): ToolRegistration<typeof WalletStatusParams> {
  const locale = deps.locale;

  return {
    name: "wallet_resume_trading",
    description:
      "Lift the trading breaker. Use it only when the owner explicitly asks to resume trading; the owner is the only one who can forgive a realized loss.",
    parameters: WalletStatusParams,
    async execute() {
      try {
        await deps.resume();
        return output(t(locale, "wallet.resume.done"));
      } catch (error) {
        warn("resume", error);
        return errorOutput(t(locale, "wallet.vitals.unavailable"));
      }
    },
  };
}
