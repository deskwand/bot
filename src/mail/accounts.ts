import { readRuntimeConfig } from "../runtime-config";
import type { MailSecurity } from "./socket";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECURITIES: readonly MailSecurity[] = ["tls", "starttls"];
const SECRET_PREFIX = "EMAIL_SECRET_";

export type Endpoint = {
  host: string;
  port: number;
  security: MailSecurity;
};

export type MailAccount = {
  id: string;
  label?: string;
  user: string;
  fromName?: string;
  imap: Endpoint;
  smtp?: Endpoint;
};

/** `EMAIL_SECRET_<ID>`: same convention as `MODEL_KEY_<ID>`. */
export function secretName(id: string): string {
  return SECRET_PREFIX + id.toUpperCase().replaceAll("-", "_");
}

function endpoint(value: unknown): Endpoint | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const { host, port, security } = raw;
  if (typeof host !== "string" || host.trim() === "") return null;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return null;
  }
  if (
    typeof security !== "string" ||
    !SECURITIES.includes(security as MailSecurity)
  ) {
    return null;
  }
  return { host: host.trim(), port, security: security as MailSecurity };
}

function account(value: unknown, env: Env): MailAccount | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = raw.id;
  const user = raw.user;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (typeof user !== "string" || user.trim() === "") return null;
  const imap = endpoint(raw.imap);
  if (imap === null) return null;

  const secret = env[secretName(id) as keyof Env];
  if (typeof secret !== "string" || secret === "") {
    console.warn(`mail account ${id} skipped: ${secretName(id)} is not set`);
    return null;
  }

  const result: MailAccount = { id, user: user.trim(), imap };
  if (typeof raw.label === "string" && raw.label !== "") result.label = raw.label;
  if (typeof raw.fromName === "string" && raw.fromName !== "") {
    result.fromName = raw.fromName;
  }
  const smtp = endpoint(raw.smtp);
  if (smtp !== null) result.smtp = smtp;
  return result;
}

/**
 * Accounts that are both configured and have their secret. Never throws: a bad
 * or half-configured account is dropped so the rest of the bot keeps working.
 */
export function configuredAccounts(env: Env): MailAccount[] {
  let configured: unknown;
  try {
    configured = readRuntimeConfig(env).email?.accounts;
  } catch {
    // An unreadable deployment document means no mail tools, never a crash.
    return [];
  }
  if (!Array.isArray(configured)) return [];
  const resolved: MailAccount[] = [];
  for (const entry of configured) {
    const parsed = account(entry, env);
    if (parsed !== null) resolved.push(parsed);
  }
  return resolved;
}

/** The named account, or the first one when no id is given. */
export function resolveAccount(
  accounts: MailAccount[],
  id?: string,
): MailAccount | null {
  if (accounts.length === 0) return null;
  if (id === undefined) return accounts[0]!;
  return accounts.find((entry) => entry.id === id) ?? null;
}
