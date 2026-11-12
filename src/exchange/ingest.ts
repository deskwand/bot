import { ownerLocale, t, type Locale } from "../i18n";
import { readRuntimeConfig } from "../runtime-config";
import { binanceAdapter } from "./binance";
import { exchangeStub } from "./exchange-do";
import { refused, type ExchangeProbe } from "./probe";
import {
  BINANCE_ENDPOINTS,
  replayFetch,
  type RecordedResponse,
} from "./replay";
import {
  BUCKETS,
  ExchangeError,
  type ExchangeAccount,
  type VenueSnapshot,
} from "./types";

/** One push from the desktop: the account, when it fetched, and what it saw. */
export type SyncBundle = {
  account: string;
  fetchedAt: number;
  responses: RecordedResponse[];
};

export type IngestDeps = {
  locale?: Locale;
  now?: () => number;
  store?: (snapshot: VenueSnapshot) => Promise<boolean>;
};

const DEFAULT_BASE_URL = "https://api.binance.com";

const KNOWN_ENDPOINTS = new Set(
  BINANCE_ENDPOINTS.map(
    (endpoint) => `${endpoint.method.toUpperCase()} ${endpoint.path}`,
  ),
);

type Configured = {
  id: string;
  venue: unknown;
  label: string;
  baseUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseResponse(value: unknown): RecordedResponse | null {
  if (!isRecord(value)) return null;
  const { method, path, status, body } = value;
  if (
    typeof method !== "string" ||
    typeof path !== "string" ||
    typeof body !== "string"
  ) {
    return null;
  }
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 0 ||
    status > 599
  ) {
    return null;
  }
  if (!KNOWN_ENDPOINTS.has(`${method.toUpperCase()} ${path}`)) return null;
  return { method, path, status, body };
}

/**
 * Validates a desktop push. `null` means the shape or one of its recorded
 * endpoints is outside what the adapter can replay, so nothing is stored.
 */
export function parseSyncBundle(value: unknown): SyncBundle | null {
  if (!isRecord(value)) return null;
  const { account, fetchedAt, responses } = value;
  if (typeof account !== "string" || account === "") return null;
  if (typeof fetchedAt !== "number" || !Number.isInteger(fetchedAt)) return null;
  if (!Array.isArray(responses) || responses.length === 0) return null;

  const parsed: RecordedResponse[] = [];
  for (const entry of responses) {
    const response = parseResponse(entry);
    if (response === null) return null;
    parsed.push(response);
  }
  return { account, fetchedAt, responses: parsed };
}

/**
 * Finds the configured account without touching the Worker secret: the
 * desktop proves the key with its own signed request.
 */
function configuredAccount(env: Env, accountId: string): Configured | null {
  let configured: unknown;
  try {
    configured = (
      readRuntimeConfig(env).exchange as { accounts?: unknown } | undefined
    )?.accounts;
  } catch {
    return null;
  }
  if (!Array.isArray(configured)) return null;

  const entry = configured.find(
    (value) => isRecord(value) && value.id === accountId,
  );
  if (!isRecord(entry)) return null;

  return {
    id: accountId,
    venue: entry.venue,
    label:
      typeof entry.label === "string" && entry.label !== ""
        ? entry.label
        : accountId,
    baseUrl:
      typeof entry.baseUrl === "string" && entry.baseUrl !== ""
        ? entry.baseUrl
        : DEFAULT_BASE_URL,
  };
}

/**
 * Replays the desktop's recorded bundle through the one Binance adapter, so
 * parsing, valuation and degradation stay in a single place. Only the count
 * and total leave this module; raw responses never touch storage.
 */
export async function ingestSnapshot(
  env: Env,
  body: unknown,
  deps: IngestDeps = {},
): Promise<ExchangeProbe> {
  const locale = deps.locale ?? ownerLocale(env);
  const bundle = parseSyncBundle(body);
  if (bundle === null) {
    return {
      ok: false,
      code: "EXCHANGE_INVALID",
      message: t(locale, "exchange.error.invalidSync"),
    };
  }

  const configured = configuredAccount(env, bundle.account);
  if (configured === null) {
    return refused("account", locale, { id: bundle.account });
  }
  if (configured.venue !== "binance") {
    return {
      ok: false,
      code: "EXCHANGE_SYNC_UNSUPPORTED",
      message: t(locale, "exchange.error.syncUnsupported"),
    };
  }

  const now = deps.now ?? Date.now;
  const account: ExchangeAccount = {
    id: configured.id,
    venue: "binance",
    label: configured.label,
    baseUrl: configured.baseUrl,
    // Replay never signs anything: this only fills the adapter's shape.
    secret: { key: "replay", secret: "replay" },
  };

  let snapshot: VenueSnapshot;
  try {
    snapshot = await binanceAdapter.fetch(
      account,
      { include: [...BUCKETS, "positions"] },
      undefined,
      {
        fetchImpl: replayFetch(bundle.responses),
        // A desktop clock that is ahead must not poison the store.
        now: () => Math.min(bundle.fetchedAt, now()),
      },
    );
  } catch (error) {
    return refused(
      error instanceof ExchangeError ? error.bucket : "network",
      locale,
    );
  }

  const store = deps.store ?? ((value) => exchangeStub(env).put(value));
  await store(snapshot);

  const currencies = snapshot.buckets.reduce(
    (count, bucket) => count + bucket.balances.length,
    0,
  );
  return snapshot.total === undefined
    ? { ok: true, venue: "binance", currencies }
    : { ok: true, venue: "binance", currencies, total: snapshot.total };
}
