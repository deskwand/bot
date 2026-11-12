import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { t, type Locale } from "../i18n";
import { CHAINS, type Token } from "./chain";
import type { WalletStatus } from "./wallet-do";
import { formatUsd } from "../life/prompt";

const WalletStatusParams = Type.Object({});

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
