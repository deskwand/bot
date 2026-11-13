import {
  SandboxError,
  type SandboxErrorCode,
  type SandboxExecResult,
  type SandboxHealth,
  type SandboxProvider,
  type SandboxRunOptions,
} from "./types";

const PROTOCOL = 1;
const HEALTH_TIMEOUT_MS = 2_000;
const RUN_GRACE_MS = 5_000;
const FILE_CAP_BYTES = 32 * 1024 * 1024;
/** A 32 MB transfer is fast; this only stops a wedged connection. */
const FILE_TIMEOUT_MS = 60_000;

function errorCode(name: string): SandboxErrorCode {
  switch (name) {
    case "UNAUTHORIZED":
    case "TOO_LARGE":
    case "DISK_FULL":
    case "NOT_FOUND":
    case "BAD_REQUEST":
      return name;
    default:
      return "UNAVAILABLE";
  }
}

async function failure(response: Response): Promise<SandboxError> {
  let code = "";
  let message = `sandbox returned ${String(response.status)}`;
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.message === "string") message = body.message;
  } catch {
    // A non-JSON error body keeps the status-based message.
  }
  return new SandboxError(
    errorCode(code),
    code === "" ? message : `${code}: ${message}`,
  );
}

/** Combines the caller's signal with a wall-clock deadline. */
function deadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timer = AbortSignal.timeout(ms);
  if (signal === undefined) return timer;
  // Listening for a later event would miss a signal that already fired.
  if (signal.aborted) return signal;
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  timer.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

export function httpSandboxProvider(
  env: { SANDBOX_URL?: string; SANDBOX_TOKEN?: string },
  fetchImpl: typeof fetch = fetch,
): SandboxProvider | null {
  const url = (env.SANDBOX_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.SANDBOX_TOKEN ?? "").trim();
  if (url === "" || token === "") return null;
  const auth = { authorization: `Bearer ${token}` };

  return {
    kind: "http",

    async health(): Promise<SandboxHealth> {
      try {
        const response = await fetchImpl(`${url}/healthz`, {
          headers: auth,
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        if (!response.ok) {
          return { ok: false, detail: `status ${String(response.status)}` };
        }
        const body = (await response.json()) as {
          protocol?: number;
          disk?: { usedBytes: number; limitBytes: number };
        };
        if (body.protocol !== PROTOCOL) {
          return { ok: false, protocol: body.protocol, detail: "protocol" };
        }
        return { ok: true, protocol: body.protocol, disk: body.disk };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : "unreachable",
        };
      }
    },

    async run(
      command: string,
      options: SandboxRunOptions = {},
    ): Promise<SandboxExecResult> {
      const timeoutMs = options.timeoutMs ?? 600_000;
      let response: Response;
      try {
        response = await fetchImpl(`${url}/exec`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ command, cwd: options.cwd, timeoutMs }),
          signal: deadline(options.signal, timeoutMs + RUN_GRACE_MS),
        });
      } catch (error) {
        throw new SandboxError(
          "UNAVAILABLE",
          error instanceof Error ? error.message : "sandbox request failed",
        );
      }
      if (!response.ok) throw await failure(response);
      return (await response.json()) as SandboxExecResult;
    },

    async readFile(path: string, maxBytes: number): Promise<Uint8Array> {
      const limit = Math.min(maxBytes, FILE_CAP_BYTES);
      const response = await fetchImpl(
        `${url}/files?path=${encodeURIComponent(path)}&maxBytes=${String(limit)}`,
        { headers: auth, signal: AbortSignal.timeout(FILE_TIMEOUT_MS) },
      );
      if (!response.ok) throw await failure(response);
      return new Uint8Array(await response.arrayBuffer());
    },

    async writeFile(path: string, data: Uint8Array): Promise<void> {
      if (data.byteLength > FILE_CAP_BYTES) {
        throw new SandboxError(
          "TOO_LARGE",
          `file is over the ${String(FILE_CAP_BYTES)} byte limit`,
        );
      }
      const response = await fetchImpl(
        `${url}/files?path=${encodeURIComponent(path)}`,
        {
          method: "PUT",
          headers: auth,
          body: data,
          signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw await failure(response);
    },
  };
}
