import { sandboxEndpoint, type SandboxFetch } from "./http";
import { SandboxError } from "./types";

/**
 * Mirrors `container/sandbox/browser-snapshot.ts`. The two are kept in step by
 * a compile-time assertion in `tests-node/browser-client.test.ts`.
 */
export type SnapshotElement = {
  ref: string;
  role: string;
  name: string;
  type?: string;
  placeholder?: string;
  href?: string;
  checked?: boolean;
};

export type Snapshot = {
  url: string;
  title: string;
  text: string;
  elements: SnapshotElement[];
  truncated: { text: boolean; elements: boolean; filtered: number };
};

export type ActAction = "click" | "fill" | "press" | "back" | "read";

export type BrowserClient = {
  /** Throws when the sandbox cannot be reached; an empty list means "no browser". */
  features(): Promise<string[]>;
  open(session: string, url: string, timeoutMs?: number): Promise<Snapshot>;
  act(
    session: string,
    action: ActAction,
    args?: { target?: string; text?: string; key?: string },
  ): Promise<Snapshot>;
  shot(session: string, fullPage?: boolean): Promise<Uint8Array>;
  close(session: string): Promise<void>;
};

const TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 2_000;

export function browserClient(
  env: { SANDBOX_URL?: string; SANDBOX_TOKEN?: string },
  fetchImpl: SandboxFetch = fetch,
): BrowserClient | null {
  const endpoint = sandboxEndpoint(env);
  if (endpoint === null) return null;
  const base = endpoint.url;
  const auth = {
    authorization: `Bearer ${endpoint.token}`,
    "content-type": "application/json",
  };

  async function post(path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<Response> {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return response;
    let code = "UNAVAILABLE";
    let message = `sandbox returned ${String(response.status)}`;
    try {
      const parsed = (await response.json()) as { code?: unknown; message?: unknown };
      if (typeof parsed.code === "string") code = parsed.code;
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      // A non-JSON body keeps the status-based message.
    }
    throw new SandboxError(code === "BAD_REQUEST" ? "BAD_REQUEST" : "UNAVAILABLE", message);
  }

  return {
    async features() {
      let response: Response;
      try {
        response = await fetchImpl(`${base}/healthz`, {
          headers: { authorization: `Bearer ${endpoint.token}` },
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
      } catch (error) {
        // "Down" and "too old" are different answers: do not blame the image
        // when it is a network failure.
        throw new SandboxError(
          "UNAVAILABLE",
          error instanceof Error ? error.message : "sandbox is not reachable",
        );
      }
      if (!response.ok) {
        throw new SandboxError("UNAVAILABLE", `sandbox returned ${String(response.status)}`);
      }
      const body = (await response.json()) as { features?: unknown };
      return Array.isArray(body.features)
        ? body.features.filter((item): item is string => typeof item === "string")
        : [];
    },

    async open(session, url, timeoutMs) {
      const response = await post("/browser/open", { session, url, timeoutMs });
      return (await response.json()) as Snapshot;
    },

    async act(session, action, args = {}) {
      const response = await post("/browser/act", {
        session,
        action,
        target: args.target,
        text: args.text,
        key: args.key,
      });
      return (await response.json()) as Snapshot;
    },

    async shot(session, fullPage = false) {
      const response = await post("/browser/shot", { session, fullPage });
      return new Uint8Array(await response.arrayBuffer());
    },

    async close(session) {
      await post("/browser/close", { session });
    },
  };
}
