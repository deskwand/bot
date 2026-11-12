import type { Token } from "./chain.ts";

export const MIN_REMIT_USD = 5;
export const REMIT_TARGET_DAYS = 21;
export const REMIT_STALE_MS = 72 * 3_600_000;
export const RECEIPT_TIMEOUT_MS = 60_000;
export const UNMINED_AFTER_MS = 10 * 60_000;
/** Reconciliation only glances at a receipt; it does not wait for mining. */
export const RECONCILE_RECEIPT_MS = 5_000;
export const READ_TIMEOUT_MS = 3_000;

export type Holdings = {
  ethWei: bigint;
  tokens: Record<Token, bigint>;
  valueUsd: number;
};

export type RemitCheck = "bad_amount" | "below_min" | "insufficient" | null;

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
