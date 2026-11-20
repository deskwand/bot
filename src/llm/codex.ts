/**
 * OpenAI Codex (ChatGPT subscription) access.
 *
 * pi-ai ships the provider, the wire API and the OAuth type, but its login
 * needs `node:crypto` and a local callback server, and its credential store is
 * app-owned. This module supplies the missing Worker-side pieces: a device-code
 * login (`auth.openai.com/codex/device`), the token refresh, and the small
 * status/disconnect surface the desktop talks to through `/admin/models/auth`.
 *
 * Endpoints and the public client id mirror
 * `@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js`.
 */
import type { Credential, OAuthAuth, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  deleteModelCredential,
  readModelCredential,
  saveModelCredential,
} from "./model-auth";

export const CODEX_PROVIDER_ID = "openai-codex";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;

/** Where the owner types the code; the code itself comes from the service. */
export const CODEX_VERIFICATION_URL = `${AUTH_BASE_URL}/codex/device`;

/** The device-auth callback the service issued the code for. */
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;

const REQUEST_TIMEOUT_MS = 15_000;

export function isCodexProvider(providerId: string): boolean {
  return providerId === CODEX_PROVIDER_ID;
}

export type CodexLoginStart = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
};

export type CodexLoginPoll = { status: "pending" | "slow_down" | "done" };

function basicHeaders(): HeadersInit {
  return { "content-type": "application/x-www-form-urlencoded" };
}

function jsonHeaders(): HeadersInit {
  return { "content-type": "application/json" };
}

async function readToken(
  response: Response,
  operation: string,
): Promise<OAuthCredential> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`codex token ${operation} failed (${response.status}): ${text}`);
  }
  const body = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    typeof body.expires_in !== "number"
  ) {
    throw new Error(`codex token ${operation} response is missing fields`);
  }
  return {
    type: "oauth",
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000,
  };
}

/** Exchange the refresh token; pi calls this from inside its write lock. */
async function refreshCredential(
  credential: OAuthCredential,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: basicHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: CLIENT_ID,
    }),
    signal,
  });
  return await readToken(response, "refresh");
}

const oauth: OAuthAuth = {
  name: "OpenAI (ChatGPT subscription)",
  isSubscription: true,
  // pi's own login is CLI-only; the Worker logs in through /admin/models/auth.
  async login() {
    throw new Error("codex login runs through /admin/models/auth");
  },
  refresh: refreshCredential,
  toAuth: async (credential) => ({ apiKey: credential.access }),
};

/** The provider as the deployment sees it: pi's models and API, our OAuth. */
export function codexProvider(): Provider {
  return Object.create(openaiCodexProvider(), {
    auth: { value: { oauth }, enumerable: true },
  }) as Provider;
}

/**
 * Ask the service for a device code. Stateless on purpose: the desktop keeps
 * the pair and hands it back on every poll.
 */
export async function startCodexLogin(
  fetchFn: typeof fetch = fetch,
): Promise<CodexLoginStart> {
  const response = await fetchFn(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`codex device code request failed (${response.status})`);
  }
  const body = (await response.json()) as {
    device_auth_id?: unknown;
    user_code?: unknown;
    interval?: unknown;
  };
  const interval =
    typeof body.interval === "string" ? Number(body.interval.trim()) : body.interval;
  if (
    typeof body.device_auth_id !== "string" ||
    typeof body.user_code !== "string" ||
    typeof interval !== "number" ||
    !Number.isFinite(interval) ||
    interval <= 0
  ) {
    throw new Error("codex device code response is missing fields");
  }
  return {
    deviceAuthId: body.device_auth_id,
    userCode: body.user_code,
    verificationUrl: CODEX_VERIFICATION_URL,
    intervalSeconds: interval,
  };
}

function errorCode(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * One poll. Stores the credential and answers `done` once the service hands
 * over an authorization code.
 */
export async function pollCodexLogin(
  device: { deviceAuthId: string; userCode: string },
  env: Env,
  fetchFn: typeof fetch = fetch,
): Promise<CodexLoginPoll> {
  const response = await fetchFn(DEVICE_TOKEN_URL, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      device_auth_id: device.deviceAuthId,
      user_code: device.userCode,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.ok) {
    const body = (await response.json()) as {
      authorization_code?: unknown;
      code_verifier?: unknown;
    };
    if (
      typeof body.authorization_code !== "string" ||
      typeof body.code_verifier !== "string"
    ) {
      throw new Error("codex device auth response is missing fields");
    }
    const before = await readModelCredential(env, CODEX_PROVIDER_ID);
    try {
      const credential = await exchangeAuthorizationCode(
        body.authorization_code,
        body.code_verifier,
        fetchFn,
      );
      await saveModelCredential(env, CODEX_PROVIDER_ID, credential);
    } catch (error) {
      // The authorization code is single-use, so a retried poll after a lost
      // response fails here even though the login succeeded. Say "done" only
      // when the stored credential actually changed; a failed re-login after a
      // sign-out must surface instead of claiming the old credential is new.
      const after = await readModelCredential(env, CODEX_PROVIDER_ID);
      const rotated =
        after !== undefined &&
        after.type === "oauth" &&
        after.refresh !== (before?.type === "oauth" ? before.refresh : null);
      if (!rotated) throw error;
    }
    return { status: "done" };
  }

  if (response.status === 403 || response.status === 404) {
    return { status: "pending" };
  }

  const body = await response.json().catch(() => null);
  const code = errorCode(body);
  if (code === "deviceauth_authorization_pending") return { status: "pending" };
  if (code === "slow_down") return { status: "slow_down" };
  throw new Error(`codex device auth failed (${response.status}): ${code ?? "unknown"}`);
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  fetchFn: typeof fetch,
): Promise<OAuthCredential> {
  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: basicHeaders(),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: DEVICE_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return await readToken(response, "exchange");
}

export async function codexStatus(env: Env): Promise<{ connected: boolean }> {
  const credential: Credential | undefined = await readModelCredential(
    env,
    CODEX_PROVIDER_ID,
  );
  return { connected: credential !== undefined };
}

export async function disconnectCodex(env: Env): Promise<void> {
  await deleteModelCredential(env, CODEX_PROVIDER_ID);
}
