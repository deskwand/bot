import { readRuntimeConfig } from "../runtime-config";
import {
  VENUE_IDS,
  type ExchangeAccount,
  type VenueId,
  type VenueSecret,
} from "./types";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECRET_PREFIX = "EXCHANGE_SECRET_";

const DEFAULT_BASE_URL: Record<VenueId, string> = {
  okx: "https://www.okx.com",
  binance: "https://api.binance.com",
};

/** `EXCHANGE_SECRET_<ID>`: same convention as `EMAIL_SECRET_<ID>`. */
export function secretNameFor(id: string): string {
  return SECRET_PREFIX + id.toUpperCase().replaceAll("-", "_");
}

function isVenue(value: unknown): value is VenueId {
  return (
    typeof value === "string" && (VENUE_IDS as readonly string[]).includes(value)
  );
}

/** https origin only: no path, query, fragment or credentials. */
export function normalizeBaseUrl(
  value: unknown,
  venue: VenueId,
): string | null {
  if (value === undefined) return DEFAULT_BASE_URL[venue];
  if (typeof value !== "string" || value.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  return url.origin;
}

/** Decodes the account secret; null when a required field is missing. */
export function parseSecret(
  venue: VenueId,
  raw: string | undefined,
): VenueSecret | null {
  if (raw === undefined || raw === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const { key, secret, passphrase } = record;
  if (typeof key !== "string" || key === "") return null;
  if (typeof secret !== "string" || secret === "") return null;
  if (venue === "okx") {
    if (typeof passphrase !== "string" || passphrase === "") return null;
    return { key, secret, passphrase };
  }
  return { key, secret };
}

function secretOf(env: Env, id: string): string | undefined {
  const value = env[secretNameFor(id) as keyof Env];
  return typeof value === "string" ? value : undefined;
}

function account(value: unknown, env: Env): ExchangeAccount | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = raw.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (!isVenue(raw.venue)) return null;
  const baseUrl = normalizeBaseUrl(raw.baseUrl, raw.venue);
  if (baseUrl === null) {
    console.warn(
      `exchange account ${id} skipped: baseUrl must be an https origin`,
    );
    return null;
  }
  const secret = parseSecret(raw.venue, secretOf(env, id));
  if (secret === null) {
    console.warn(
      `exchange account ${id} skipped: ${secretNameFor(id)} is missing or incomplete`,
    );
    return null;
  }
  const label =
    typeof raw.label === "string" && raw.label !== "" ? raw.label : id;
  return { id, venue: raw.venue, label, baseUrl, secret };
}

/**
 * Accounts that are both configured and complete. Never throws: a bad or
 * half-configured account is dropped so the rest of the bot keeps working.
 */
export function configuredAccounts(env: Env): ExchangeAccount[] {
  let configured: unknown;
  try {
    configured = (
      readRuntimeConfig(env).exchange as { accounts?: unknown } | undefined
    )?.accounts;
  } catch {
    // An unreadable deployment document means no exchange tools, never a crash.
    return [];
  }
  if (!Array.isArray(configured)) return [];

  const seen = new Set<string>();
  const resolved: ExchangeAccount[] = [];
  for (const entry of configured) {
    const parsed = account(entry, env);
    if (parsed === null) continue;
    if (seen.has(parsed.id)) {
      console.warn(`exchange account ${parsed.id} skipped: duplicate id`);
      continue;
    }
    seen.add(parsed.id);
    resolved.push(parsed);
  }
  return resolved;
}
