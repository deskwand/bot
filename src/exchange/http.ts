import {
  ExchangeError,
  type AdapterDeps,
  type ErrorBucket,
  type ExchangeAccount,
} from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;

const BINANCE_DEFAULT_BASE = "https://api.binance.com";

/**
 * The only endpoints allowed to use anything but GET. Binance models a couple
 * of pure queries as POST; callers cannot pick a method, it is derived from
 * this allowlist, so no code path can build a write request.
 */
const BINANCE_READ_POST_PATHS: ReadonlySet<string> = new Set([
  "/sapi/v1/asset/get-funding-asset",
]);

function methodFor(path: string): "GET" | "POST" {
  return BINANCE_READ_POST_PATHS.has(path) ? "POST" : "GET";
}

async function hmac(secret: string, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Binance signs the raw query string and sends the hex digest. */
export async function binanceSignature(
  secret: string,
  query: string,
): Promise<string> {
  return hex(await hmac(secret, query));
}

/** OKX signs timestamp + METHOD + path-with-query and sends base64 of the digest. */
export async function okxSignature(
  secret: string,
  timestamp: string,
  pathAndQuery: string,
): Promise<string> {
  return base64(await hmac(secret, `${timestamp}GET${pathAndQuery}`));
}

export function okxTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

/** Exchange payloads send numbers as strings, and sometimes as "". */
export function num(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export type HttpDeps = AdapterDeps;

/** A 403 body explains itself only for region blocks; everything else is a key problem. */
export function errorBucketForStatus(
  status: number,
  body: string,
): ErrorBucket {
  if (status === 451) return "region";
  if (status === 418 || status === 429) return "rate";
  if (status === 401) return "unknownKey";
  if (status === 403) {
    return /restricted|blocked|unsupported/i.test(body) ? "region" : "unknownKey";
  }
  if (status === 408 || status === 504) return "timeout";
  return "network";
}

const OKX_CODES: Record<string, ErrorBucket> = {
  "50011": "rate",
  "50102": "timestamp",
  "50105": "passphrase",
  "50111": "unknownKey",
  "50113": "signature",
  "50119": "wrongDomain",
};

const BINANCE_CODES: Record<string, ErrorBucket> = {
  "-1003": "rate",
  "-1021": "timestamp",
  "-1022": "signature",
  "-2014": "unknownKey",
  "-2015": "unknownKey",
};

function bodyErrorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string"
    ? String(code)
    : undefined;
}

function signalOf(deps: HttpDeps, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

type RawResponse = {
  status: number;
  ok: boolean;
  text: string;
  body: unknown;
};

/** Transports one request without judging it; each venue classifies the reply. */
async function send(
  deps: HttpDeps,
  url: string,
  init: RequestInit,
): Promise<RawResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    throw new ExchangeError(name === "TimeoutError" ? "timeout" : "network");
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, ok: response.ok, text, body };
}

/**
 * Business codes come first: Binance and OKX both report some failures with a
 * 4xx and a code that says more than the status does.
 */
function refusal(
  raw: RawResponse,
  codes: Record<string, ErrorBucket>,
): ExchangeError | null {
  const code = bodyErrorCode(raw.body);
  if (code !== undefined && codes[code] !== undefined) {
    return new ExchangeError(codes[code], raw.status, code);
  }
  if (!raw.ok) {
    return new ExchangeError(
      errorBucketForStatus(raw.status, raw.text),
      raw.status,
      code,
    );
  }
  if (raw.body === undefined) return new ExchangeError("parse", raw.status);
  return null;
}

export async function okxGet(
  deps: HttpDeps,
  account: ExchangeAccount,
  path: string,
  query: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<unknown[]> {
  const search = new URLSearchParams(query).toString();
  const pathAndQuery = search === "" ? path : `${path}?${search}`;
  const timestamp = okxTimestamp((deps.now ?? Date.now)());
  const signature = await okxSignature(
    account.secret.secret,
    timestamp,
    pathAndQuery,
  );

  const raw = await send(deps, `${account.baseUrl}${pathAndQuery}`, {
    method: "GET",
    headers: {
      "OK-ACCESS-KEY": account.secret.key,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": account.secret.passphrase ?? "",
      "content-type": "application/json",
    },
    signal: signalOf(deps, signal),
  });

  // OKX reports business failures inside a 200 envelope with code !== "0";
  // unknown codes stay in the network bucket so a new code cannot look like success.
  const code = bodyErrorCode(raw.body);
  const failure =
    code !== undefined && code !== "0"
      ? new ExchangeError(OKX_CODES[code] ?? "refused", raw.status, code)
      : refusal(raw, OKX_CODES);
  if (failure !== null) {
    console.warn(`okx ${path} failed (${failure.bucket})`);
    throw failure;
  }

  const data = (raw.body as { data?: unknown }).data;
  return Array.isArray(data) ? data : [];
}

/** The read-only POST allowlist, so a test can pin its exact contents. */
export const BINANCE_POST_READS: readonly string[] = [
  ...BINANCE_READ_POST_PATHS,
];

export async function binanceGet(
  deps: HttpDeps,
  account: ExchangeAccount,
  path: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const timestamp = String((deps.now ?? Date.now)());
  // Binance does not require a particular order, but a fixed one keeps the
  // signature reproducible: timestamp, recvWindow, then caller params.
  const query = new URLSearchParams({
    timestamp,
    recvWindow: "5000",
    ...params,
  }).toString();
  const signature = await binanceSignature(account.secret.secret, query);
  const host = hostFor(account, path);
  const raw = await send(
    deps,
    `${host}${path}?${query}&signature=${signature}`,
    {
      method: methodFor(path),
      headers: { "X-MBX-APIKEY": account.secret.key },
      signal: signalOf(deps, signal),
    },
  );

  const failure = refusal(raw, BINANCE_CODES);
  if (failure !== null) {
    console.warn(`binance ${path} failed (${failure.bucket})`);
    throw failure;
  }
  return raw.body;
}

/** A configured baseUrl proxies every path; otherwise futures get their own hosts. */
function hostFor(account: ExchangeAccount, path: string): string {
  if (account.baseUrl !== BINANCE_DEFAULT_BASE) return account.baseUrl;
  if (path.startsWith("/fapi/")) return "https://fapi.binance.com";
  if (path.startsWith("/dapi/")) return "https://dapi.binance.com";
  return BINANCE_DEFAULT_BASE;
}
