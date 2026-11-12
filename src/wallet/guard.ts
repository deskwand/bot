import type { Token } from "./chain.ts";

export const MIN_REMIT_USD = 5;
export const REMIT_TARGET_DAYS = 21;
export const REMIT_STALE_MS = 72 * 3_600_000;
export const RECEIPT_TIMEOUT_MS = 60_000;
export const UNMINED_AFTER_MS = 10 * 60_000;
/** Reconciliation only glances at a receipt; it does not wait for mining. */
export const RECONCILE_RECEIPT_MS = 5_000;
export const READ_TIMEOUT_MS = 3_000;

export const MAX_TRADE_SHARE = 0.25;
export const SLIPPAGE = 0.01;
export const BREAKER_LOSS_SHARE = 0.1;
export const GAS_RESERVE_WEI = 2_000_000_000_000_000n;
export const MIN_VALUE_USD = 5;
export const PRICE_KEEP_MS = 30 * 86_400_000;
export const PRICE_PROBE_USDC = 1000_000_000n;
export const MAX_PRICE_HOURS = 168;

export type Holdings = {
  ethWei: bigint;
  tokens: Record<Token, bigint>;
  valueUsd: number;
};

export type RemitCheck = "bad_amount" | "below_min" | "insufficient" | null;

export type SwapCheck = {
  sell: Token;
  buy: Token;
  amountIn: bigint;
  amountInUsd: number;
  holdings: Holdings;
  realizedLossUsd: number;
  feeTier: number | undefined;
  whitelisted: boolean;
};

export type Refusal =
  | "not_whitelisted"
  | "same_token"
  | "no_pool"
  | "bad_amount"
  | "depleted"
  | "breaker"
  | "gas_low"
  | "insufficient"
  | "too_large";

/**
 * Compares the loss against the value without the float drift of `value * 0.1`.
 * No loss never trips it, even on an empty wallet.
 */
export function breakerTripped(lossUsd: number, valueUsd: number): boolean {
  return lossUsd > 0 && lossUsd * 10 >= valueUsd;
}

/** The swap rules, in the order the spec lists them. */
export function checkSwap(c: SwapCheck): Refusal | null {
  if (!c.whitelisted) return "not_whitelisted";
  if (c.sell === c.buy) return "same_token";
  if (c.feeTier === undefined) return "no_pool";
  if (c.amountIn <= 0n) return "bad_amount";
  if (c.holdings.valueUsd < MIN_VALUE_USD) return "depleted";
  if (breakerTripped(c.realizedLossUsd, c.holdings.valueUsd)) return "breaker";
  if (c.holdings.ethWei < GAS_RESERVE_WEI) return "gas_low";
  if (c.holdings.tokens[c.sell] < c.amountIn) return "insufficient";
  if (c.amountInUsd * 4 > c.holdings.valueUsd) return "too_large";
  return null;
}

/** Ninety-nine percent of the quote, rounded down. */
export function minOut(quoted: bigint): bigint {
  return (quoted * 99n) / 100n;
}

/**
 * The breaker window begins at whichever is latest: 24 hours ago, today's UTC
 * midnight, or the owner's last resume.
 */
export function lossWindowStart(
  now: number,
  resumedAt: number | null,
): number {
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  return Math.max(now - 86_400_000, dayStart, resumedAt ?? 0);
}

/** Parses a plain decimal string into token base units, or `null`. */
export function parseTokenAmount(
  text: string,
  decimals: number,
): bigint | null {
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/** The remittance rules, in the order the spec lists them. */
export function checkRemit(
  amountUsdc: bigint,
  usdcBalance: bigint,
): RemitCheck {
  if (amountUsdc <= 0n) return "bad_amount";
  if (amountUsdc < BigInt(MIN_REMIT_USD) * 1_000_000n) return "below_min";
  if (amountUsdc > usdcBalance) return "insufficient";
  return null;
}

/** How much to send so the given daily spend is covered for 21 days. */
export function remitAmountUsd(
  dailySpendUsd: number,
  balanceUsd: number,
): number {
  return Math.max(0, Math.ceil(dailySpendUsd * REMIT_TARGET_DAYS - balanceUsd));
}
