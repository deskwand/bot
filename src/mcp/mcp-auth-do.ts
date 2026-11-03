import { Agent } from "agents";
import type { McpServerConfig } from "../config";
import { RuntimeConfigError, readRuntimeConfig } from "../runtime-config";
import {
  mcpConnector,
  probeMcpServer,
  type McpProbeResult,
} from "../tools/mcp";
import { McpAuthStore } from "./auth-store";
import {
  OAuthGrantError,
  beginAuthorization,
  finishAuthorization,
  refreshTokens,
  type OAuthClient,
  type OAuthDeps,
} from "./oauth";

export type McpAuthState = "ok" | "needs_reauth" | "unauthorized";

/** Refresh an access token once it has less than this left. */
const REFRESH_THRESHOLD_MS = 60_000;

const AUTH_REQUIRED = "需要在桌面端登录授权";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Single global object (named "global") that owns OAuth client registrations
 * and tokens for remote MCP servers. It never talks to a model or runs tools:
 * tasks ask it for a Bearer token, and the desktop asks it to probe a server.
 */
export class McpAuthDO extends Agent<Env> {
  private readonly store: McpAuthStore;

  /** Single-flight guard so concurrent calls share one refresh. */
  private readonly refreshing = new Map<string, Promise<string | null>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new McpAuthStore(ctx.storage.sql);
  }

  /** Test seam: the network, clock and randomness the OAuth flow uses. */
  oauthDeps(): OAuthDeps {
    return {
      fetch: (input, init) => fetch(input, init),
      randomHex: (bytes) => {
        const buffer = new Uint8Array(bytes);
        crypto.getRandomValues(buffer);
        return Array.from(buffer, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      },
      now: () => Date.now(),
    };
  }

  async startAuthorization(name: string): Promise<{ url: string }> {
    const server = this.oauthServer(name);
    const deps = this.oauthDeps();
    const existing = this.store.getClient(name, server.url);

    const begun = await beginAuthorization(
      server.url,
      this.redirectUri(),
      existing,
      deps,
    );
    this.store.saveClient(name, server.url, begun.client, deps.now());
    this.store.putPending(begun.state, name, begun.verifier, deps.now());

    return { url: begun.authorizeUrl };
  }

  /**
   * Redeem the callback's code. `state` is one-time and short-lived, so a
   * replayed or late callback fails without touching stored tokens.
   */
  async completeAuthorization(state: string, code: string): Promise<boolean> {
    const deps = this.oauthDeps();
    const pending = this.store.takePending(state, deps.now());
    if (pending === null) return false;

    try {
      const server = this.oauthServer(pending.name);
      const client = this.store.getClient(pending.name, server.url);
      if (client === null) return false;

      const tokens = await finishAuthorization(
        server.url,
        client,
        code,
        pending.verifier,
        this.redirectUri(),
        deps,
      );
      this.store.saveTokens(pending.name, server.url, tokens);
      return true;
    } catch (error) {
      console.error(`mcp oauth callback failed for ${pending.name}:`, error);
      return false;
    }
  }

  /**
   * A usable Bearer token for the configured URL, refreshing it shortly
   * before expiry. Null means the server needs (re-)authorization.
   */
  async accessToken(name: string, url: string): Promise<string | null> {
    const row = this.store.getTokens(name, url);
    if (row === null || row.state !== "ok") return null;
    if (
      row.expiresAt === null ||
      row.expiresAt - this.oauthDeps().now() >= REFRESH_THRESHOLD_MS
    ) {
      return row.accessToken;
    }

    const running = this.refreshing.get(name);
    if (running !== undefined) return running;

    let refresh: Promise<string | null>;
    refresh = this.refreshOnce(name, row.refreshToken, url).finally(() => {
      if (this.refreshing.get(name) === refresh) {
        this.refreshing.delete(name);
      }
    });
    this.refreshing.set(name, refresh);
    return refresh;
  }

  /** OAuth servers that need a token, with their current authorization state. */
  async status(): Promise<{ name: string; state: McpAuthState }[]> {
    let servers: McpServerConfig[];
    try {
      servers = readRuntimeConfig(this.env).mcpServers;
    } catch (error) {
      if (error instanceof RuntimeConfigError) return [];
      throw error;
    }

    return servers
      .filter((server) => server.oauth === true)
      .map((server) => ({
        name: server.name,
        state: this.authState(server),
      }));
  }

  async revoke(name: string): Promise<void> {
    this.store.deleteClient(name);
    this.store.deleteTokens(name);
    this.store.deletePendingFor(name);
  }

  /**
   * Test a server with the same connector tasks use. An OAuth server without a
   * usable token reports its auth state instead of attempting a connection.
   */
  async probe(
    name: string,
  ): Promise<
    McpProbeResult | { ok: false; reason: string; auth: McpAuthState }
  > {
    try {
      const server = this.configuredServer(name);
      if (server.oauth === true) {
        const auth = this.authState(server);
        if (auth !== "ok") {
          return { ok: false, reason: AUTH_REQUIRED, auth };
        }
      }

      return await probeMcpServer(
        server,
        mcpConnector(this.mcp, this.env, (target) =>
          this.accessToken(target.name, target.url),
        ),
      );
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }

  private async refreshOnce(
    name: string,
    refreshToken: string | null,
    url: string,
  ): Promise<string | null> {
    const client = this.store.getClient(name, url);
    if (client === null || refreshToken === null) {
      this.store.markNeedsReauth(name);
      await this.notifyInvalid(name);
      return null;
    }

    try {
      const tokens = await refreshTokens(
        url,
        client,
        refreshToken,
        this.oauthDeps(),
      );
      this.store.saveTokens(name, url, tokens);
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof OAuthGrantError) {
        this.store.markNeedsReauth(name);
        await this.notifyInvalid(name);
      } else {
        // A transport failure is temporary: keep the token set so the next
        // attempt can still refresh instead of forcing a sign-in.
        console.error(`mcp oauth refresh failed for ${name}:`, error);
      }
      return null;
    }
  }

  /** Send the "authorization expired" message once per token set. */
  private async notifyInvalid(name: string): Promise<void> {
    if (!this.store.takeNotice(name)) return;

    try {
      await this.env.BUTLER.get(
        this.env.BUTLER.idFromName("owner"),
      ).systemNotice(`🔑 ${name} 授权已失效，请在桌面端重新登录`);
    } catch (error) {
      console.error("mcp auth notice failed:", error);
    }
  }

  private authState(server: McpServerConfig): McpAuthState {
    const row = this.store.getTokens(server.name, server.url);
    if (row === null) return "unauthorized";
    return row.state === "needs_reauth" ? "needs_reauth" : "ok";
  }

  private configuredServer(name: string): McpServerConfig {
    const server = readRuntimeConfig(this.env).mcpServers.find(
      (entry) => entry.name === name,
    );
    if (server === undefined) throw new Error("服务不存在");
    return server;
  }

  private oauthServer(name: string): McpServerConfig {
    const server = this.configuredServer(name);
    if (server.oauth !== true) throw new Error("服务不存在或不需要授权");
    return server;
  }

  private redirectUri(): string {
    return `${this.env.PUBLIC_BASE_URL}/mcp/oauth/callback`;
  }
}
