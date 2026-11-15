import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
// Type-only: importing the manager at runtime would drag playwright-core into
// this module, and the endpoint tests must not need it.
import type { ActAction, BrowserManager } from "./browser.js";
import { createDiskProbe, type DiskUsage } from "./disk.js";
import { runCommand, type ExecLimits } from "./exec.js";
import {
  readSandboxFile,
  SandboxFileError,
  writeSandboxFile,
} from "./files.js";

export const PROTOCOL = 1;

const DEFAULT_DISK_LIMIT_MB = 10240;

/** A malformed SANDBOX_DISK_MB must not silently disable the disk check. */
export function parseDiskLimitMb(raw: string | undefined): number {
  const mb = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_DISK_LIMIT_MB * 1024 * 1024;
  return mb * 1024 * 1024;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export type SandboxdConfig = ExecLimits & {
  token: string;
  version: string;
  diskLimitBytes: number;
  /** Absent when the image has no browser; every /browser/* call then 503s. */
  browser?: BrowserManager;
};

export type Sandboxd = {
  server: Server;
  port: number;
  close(): Promise<void>;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function fail(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  json(res, status, { code, message });
}

/** A request problem that carries its own status code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function authorized(req: IncomingMessage, token: string): boolean {
  return header(req, "authorization") === `Bearer ${token}`;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "TOO_LARGE", "body is over the 32 MB limit");
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "invalid JSON body");
  }
}

export function createSandboxdHandler(config: SandboxdConfig) {
  const disk = createDiskProbe(config.sandboxDir, config.diskLimitBytes);

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://sandbox");

    if (!authorized(req, config.token)) {
      return fail(res, 401, "UNAUTHORIZED", "missing or wrong token");
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      const usage: DiskUsage = await disk.usage();
      return json(res, 200, {
        ok: true,
        protocol: PROTOCOL,
        version: config.version,
        uptimeSec: Math.round(process.uptime()),
        disk: usage,
        features: config.browser === undefined ? [] : ["browser"],
      });
    }

    if (req.method === "POST" && url.pathname.startsWith("/browser/")) {
      const browser = config.browser;
      if (browser === undefined) {
        return fail(res, 503, "UNAVAILABLE", "browser is not configured");
      }
      const body = (await readJson(req)) as Record<string, unknown>;
      const session = typeof body.session === "string" ? body.session : "";
      if (session === "") return fail(res, 400, "BAD_REQUEST", "session is required");

      try {
        if (url.pathname === "/browser/open") {
          const target = typeof body.url === "string" ? body.url : "";
          if (!/^https?:/i.test(target)) {
            return fail(res, 400, "BAD_REQUEST", "url must be http(s)");
          }
          const timeoutMs =
            typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
              ? body.timeoutMs
              : undefined;
          return json(res, 200, await browser.open(session, target, timeoutMs));
        }

        if (url.pathname === "/browser/act") {
          const action = body.action;
          if (
            action !== "click" &&
            action !== "fill" &&
            action !== "press" &&
            action !== "back" &&
            action !== "read"
          ) {
            return fail(res, 400, "BAD_REQUEST", "unknown action");
          }
          return json(
            res,
            200,
            await browser.act(session, action as ActAction, {
              target: typeof body.target === "string" ? body.target : undefined,
              text: typeof body.text === "string" ? body.text : undefined,
              key: typeof body.key === "string" ? body.key : undefined,
            }),
          );
        }

        if (url.pathname === "/browser/shot") {
          const bytes = await browser.shot(session, body.fullPage === true);
          res.writeHead(200, {
            "content-type": "image/png",
            "content-length": bytes.byteLength,
          });
          res.end(Buffer.from(bytes));
          return;
        }

        if (url.pathname === "/browser/close") {
          await browser.close(session);
          return json(res, 200, { ok: true });
        }

        return fail(res, 404, "NOT_FOUND", "no such browser endpoint");
      } catch (error) {
        // BrowserError carries the status; anything else is a real 500.
        const { code } = error as { code?: string };
        const message = error instanceof Error ? error.message : "browser failure";
        switch (code) {
          case "STALE_REF":
          case "NO_SESSION":
            return fail(res, 409, code, message);
          case "TOO_LARGE":
            return fail(res, 413, code, message);
          case "BAD_REQUEST":
            return fail(res, 400, code, message);
          case "BROWSER_DEAD":
            return fail(res, 502, code, message);
          default:
            return fail(res, 500, "INTERNAL", message);
        }
      }
    }

    if (req.method === "POST" && url.pathname === "/exec") {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (error) {
        if (error instanceof HttpError) {
          return fail(res, error.status, error.code, error.message);
        }
        return fail(res, 400, "BAD_REQUEST", "unreadable body");
      }
      const input = body as {
        command?: unknown;
        cwd?: unknown;
        timeoutMs?: unknown;
        stdoutLimit?: unknown;
        stderrLimit?: unknown;
      };
      if (typeof input.command !== "string" || input.command === "") {
        return fail(res, 400, "BAD_REQUEST", "command must be a non-empty string");
      }
      const outcome = await runCommand(
        {
          command: input.command,
          cwd: typeof input.cwd === "string" ? input.cwd : undefined,
          timeoutMs:
            typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
          stdoutLimit:
            typeof input.stdoutLimit === "number" ? input.stdoutLimit : undefined,
          stderrLimit:
            typeof input.stderrLimit === "number" ? input.stderrLimit : undefined,
        },
        config,
      );
      return json(res, 200, { ...outcome, disk: await disk.usage() });
    }

    if (
      url.pathname === "/files" &&
      (req.method === "GET" || req.method === "PUT")
    ) {
      const rawPath = url.searchParams.get("path") ?? "";
      try {
        if (req.method === "GET") {
          const maxBytes = Number.parseInt(
            url.searchParams.get("maxBytes") ?? String(MAX_BODY_BYTES),
            10,
          );
          const data = await readSandboxFile(rawPath, maxBytes);
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": data.length,
          });
          res.end(data);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const buffer = chunk as Buffer;
          size += buffer.length;
          if (size > MAX_BODY_BYTES) {
            return fail(res, 413, "TOO_LARGE", "body is over the 32 MB limit");
          }
          chunks.push(buffer);
        }
        const data = Buffer.concat(chunks);
        // Fresh reading: a cached one would let the write that just filled the
        // disk be followed by another accepted write for up to 10 seconds.
        const usage = await disk.usage(true);
        const written = await writeSandboxFile(rawPath, data, {
          diskLimitBytes: config.diskLimitBytes,
          usedBytes: usage.usedBytes,
        });
        return json(res, 200, { size: written });
      } catch (error) {
        if (error instanceof SandboxFileError) {
          const status =
            error.code === "NOT_FOUND"
              ? 404
              : error.code === "DISK_FULL"
                ? 409
                : error.code === "TOO_LARGE"
                  ? 413
                  : 400;
          return fail(res, status, error.code, error.message);
        }
        return fail(res, 500, "INTERNAL", "file operation failed");
      }
    }

    return fail(res, 404, "NOT_FOUND", "no such endpoint");
  };
}

export function startSandboxd(
  config: SandboxdConfig,
  port = 8080,
): Promise<Sandboxd> {
  const handle = createSandboxdHandler(config);
  // Idle reuse lives here, not in the manager: the manager stays timer-free and
  // therefore testable. No `unref()`: the listening server already holds the
  // process, and workers' `setInterval` typing has no unref.
  const sweeper: ReturnType<typeof setInterval> = setInterval(() => {
    void config.browser?.sweep();
  }, 60_000);
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        fail(res, error.status, error.code, error.message);
        return;
      }
      fail(res, 500, "INTERNAL", "unexpected failure");
    });
  });
  return new Promise<Sandboxd>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      const address = server.address();
      const bound =
        typeof address === "object" && address !== null ? address.port : port;
      resolve({
        server,
        port: bound,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweeper);
            // `?.()` would leave `undefined` and `.finally` would throw inside
            // the promise executor, hanging every close() forever.
            const stopping = config.browser?.shutdown() ?? Promise.resolve();
            void stopping.finally(() => {
              server.close(() => done());
            });
          }),
      });
    });
  });
}
