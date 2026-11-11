import { ownerLocale, t, type Locale, type MessageKey } from "../i18n";
import { readRuntimeConfig } from "../runtime-config";
import { configuredAccounts } from "./accounts";
import { binanceAdapter } from "./binance";
import { okxAdapter } from "./okx";
import {
  ExchangeError,
  type AdapterDeps,
  type ErrorBucket,
  type VenueId,
  type VenueSnapshot,
} from "./types";

export type ExchangeProbe =
  | { ok: true; venue: VenueId; currencies: number; total?: number }
  | { ok: false; code: string; message: string };

/** `account` is the code the desktop retries while a fresh version propagates. */
const PROBE_CODES: Record<ErrorBucket, string> = {
  region: "EXCHANGE_REGION_BLOCKED",
  unknownKey: "EXCHANGE_UNKNOWN_KEY",
  wrongDomain: "EXCHANGE_WRONG_DOMAIN",
  signature: "EXCHANGE_SIGNATURE",
  timestamp: "EXCHANGE_TIMESTAMP",
  passphrase: "EXCHANGE_PASSPHRASE",
  rate: "EXCHANGE_RATE_LIMITED",
  timeout: "EXCHANGE_TIMEOUT",
  network: "EXCHANGE_NETWORK",
  parse: "EXCHANGE_PARSE",
  refused: "EXCHANGE_REFUSED",
  account: "EXCHANGE_ACCOUNT_UNKNOWN",
};

const ADAPTERS = { okx: okxAdapter, binance: binanceAdapter } as const;

function refused(bucket: ErrorBucket, locale: Locale): ExchangeProbe {
  return {
    ok: false,
    code: PROBE_CODES[bucket],
    message: t(locale, `exchange.error.${bucket}` as MessageKey),
  };
}

function isConfigured(env: Env, accountId: string): boolean {
  try {
    const section = readRuntimeConfig(env).exchange as
      | { accounts?: unknown }
      | undefined;
    if (!Array.isArray(section?.accounts)) return false;
    return section.accounts.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { id?: unknown }).id === accountId,
    );
  } catch {
    // An unreadable document means nothing is configured.
    return false;
  }
}

/**
 * One main-endpoint call per account. Only the currency count and the total go
 * back: no balances, no raw responses. Failures are fixed codes the desktop can
 * retry or translate.
 */
export async function probeExchange(
  env: Env,
  accountId: string,
  deps: { locale?: Locale } & Omit<AdapterDeps, "now"> = {},
): Promise<ExchangeProbe> {
  const locale = deps.locale ?? ownerLocale(env);
  const account = configuredAccounts(env).find(
    (entry) => entry.id === accountId,
  );
  if (account === undefined) {
    // A configured id without a usable secret is a different fix from a typo.
    return isConfigured(env, accountId)
      ? {
          ok: false,
          code: "EXCHANGE_SECRET_MISSING",
          message: t(locale, "exchange.error.unknownKey"),
        }
      : refused("account", locale);
  }

  let snapshot: VenueSnapshot;
  try {
    snapshot = await ADAPTERS[account.venue].fetch(
      account,
      { include: ["spot"] },
      undefined,
      { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs },
    );
  } catch (error) {
    return refused(
      error instanceof ExchangeError ? error.bucket : "network",
      locale,
    );
  }

  const currencies = snapshot.buckets.reduce(
    (count, bucket) => count + bucket.balances.length,
    0,
  );
  return snapshot.total === undefined
    ? { ok: true, venue: account.venue, currencies }
    : { ok: true, venue: account.venue, currencies, total: snapshot.total };
}
