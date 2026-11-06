import {
  OAuthError,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
} from "@modelcontextprotocol/client";
import { McpUserError } from "./errors";

/** Everything the OAuth flow needs from the outside world. */
export type OAuthDeps = {
  fetch: typeof fetch;
  randomHex(bytes: number): string;
  now(): number;
};

/** A dynamically registered client, remembered across authorizations. */
export type OAuthClient = {
  issuer: string;
  clientId: string;
  clientSecret?: string;
};

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
  scope?: string;
};

/** The authorization server rejected the grant: the user must sign in again. */
export class OAuthGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthGrantError";
  }
}

const CLIENT_METADATA = {
  client_name: "DeskWand Bot",
  grant_types: ["authorization_code", "refresh_token"],
  token_endpoint_auth_method: "none",
} satisfies Omit<OAuthClientMetadata, "redirect_uris">;

function clientInformation(client: OAuthClient): OAuthClientInformationMixed {
  return {
    client_id: client.clientId,
    client_secret: client.clientSecret,
  };
}

function toTokens(
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  },
  now: number,
): OAuthTokens {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt:
      typeof tokens.expires_in === "number"
        ? now + tokens.expires_in * 1000
        : null,
    scope: tokens.scope,
  };
}

/**
 * Discover the authorization server, register a client with DCR when needed,
 * and build the authorization URL with a fresh PKCE verifier and `state`.
 */
export async function beginAuthorization(
  serverUrl: string,
  redirectUri: string,
  existing: OAuthClient | null,
  deps: OAuthDeps,
): Promise<{
  client: OAuthClient;
  authorizeUrl: string;
  verifier: string;
  state: string;
}> {
  const info = await discoverOAuthServerInfo(serverUrl, { fetchFn: deps.fetch });
  const issuer = info.authorizationServerUrl;
  const metadata = info.authorizationServerMetadata;

  let client =
    existing !== null && existing.issuer === issuer ? existing : null;
  if (client === null) {
    if (!metadata?.registration_endpoint) {
      throw new McpUserError("MCP_DCR_UNSUPPORTED");
    }

    const registered = await registerClient(issuer, {
      metadata,
      clientMetadata: { ...CLIENT_METADATA, redirect_uris: [redirectUri] },
      fetchFn: deps.fetch,
    });
    client = {
      issuer,
      clientId: registered.client_id,
      clientSecret: registered.client_secret,
    };
  }

  const state = deps.randomHex(32);
  const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, {
    metadata,
    clientInformation: clientInformation(client),
    redirectUrl: redirectUri,
    state,
    resource: serverUrl,
  });

  return {
    client,
    authorizeUrl: authorizationUrl.toString(),
    verifier: codeVerifier,
    state,
  };
}

/** Exchange the callback's authorization code for tokens. */
export async function finishAuthorization(
  serverUrl: string,
  client: OAuthClient,
  code: string,
  verifier: string,
  redirectUri: string,
  deps: OAuthDeps,
): Promise<OAuthTokens> {
  const info = await discoverOAuthServerInfo(serverUrl, { fetchFn: deps.fetch });
  const tokens = await exchangeAuthorization(client.issuer, {
    metadata: info.authorizationServerMetadata,
    clientInformation: clientInformation(client),
    authorizationCode: code,
    codeVerifier: verifier,
    redirectUri,
    resource: serverUrl,
    fetchFn: deps.fetch,
  });

  return toTokens(tokens, deps.now());
}

/** Refresh an access token; any rejection means the user must sign in again. */
export async function refreshTokens(
  serverUrl: string,
  client: OAuthClient,
  refreshToken: string,
  deps: OAuthDeps,
): Promise<OAuthTokens> {
  try {
    const info = await discoverOAuthServerInfo(serverUrl, { fetchFn: deps.fetch });
    const tokens = await refreshAuthorization(client.issuer, {
      metadata: info.authorizationServerMetadata,
      clientInformation: clientInformation(client),
      refreshToken,
      resource: serverUrl,
      fetchFn: deps.fetch,
    });

    return toTokens(
      { ...tokens, refresh_token: tokens.refresh_token ?? refreshToken },
      deps.now(),
    );
  } catch (error) {
    if (error instanceof OAuthError || isOAuthError(error)) {
      throw new OAuthGrantError(
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}

/** The SDK brands its errors, so a name check also covers duplicate modules. */
function isOAuthError(error: unknown): error is { name: string } {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "OAuthError"
  );
}
