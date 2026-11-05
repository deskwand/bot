import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { rejectionText, type ApprovalGateLike } from "../task/approvals";
import { readCapped, truncate, withAbort } from "./http-body";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];

const READ_ONLY: ReadonlySet<Method> = new Set<Method>(["GET", "HEAD"]);

const HttpRequest = Type.Object({
  url: Type.String(),
  method: Type.Optional(Type.Union([
    Type.Literal("GET"), Type.Literal("HEAD"), Type.Literal("POST"),
    Type.Literal("PUT"), Type.Literal("PATCH"), Type.Literal("DELETE"),
  ])),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  body: Type.Optional(Type.String()),
});

type HttpRequestArgs = {
  url: string;
  method?: Method;
  headers?: Record<string, string>;
  body?: string;
};

const HttpResult = Type.Object({
  status: Type.Number(),
  contentType: Type.String(),
  headers: Type.Record(Type.String(), Type.String()),
  body: Type.String(),
  bodyBase64: Type.Boolean(),
  truncated: Type.Boolean(),
});

const TIMEOUT_MS = 30_000;
const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const MAX_SCRIPT_BODY_CHARS = 1_000_000;
const SECRET_HEADER = /authorization|api[-_]?key|cookie|token|secret/i;

const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal)$/i;
const BLOCKED_V4 =
  /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** Hosts this tool refuses to reach, whatever the owner approves. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (BLOCKED_HOST.test(host)) return true;
  // IPv6 rules apply only to literals. A hostname may legitimately start with
  // "fc" (fcorp.example.com), so the colon check comes first.
  if (host.includes(":")) {
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
      return isBlockedHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return (
      host === "::" ||
      host === "::1" ||
      /^fe[89ab][0-9a-f]:/.test(host) ||
      /^f[cd][0-9a-f]{2}:/.test(host)
    );
  }
  return BLOCKED_V4.test(host);
}

/** Hide URL credentials, query values and fragments in progress and approvals. */
export function safeRequestUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const name of [...url.searchParams.keys()]) url.searchParams.set(name, "***");
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[无效 URL]";
  }
}

/** What the approval card and the approvals table are allowed to contain. */
export function redactArgs(args: HttpRequestArgs): Record<string, unknown> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(args.headers ?? {})) {
    headers[name] = SECRET_HEADER.test(name) ? "***" : value;
  }
  return {
    method: args.method ?? "GET",
    url: safeRequestUrl(args.url),
    headers,
    bodyBytes: args.body === undefined ? 0 : new TextEncoder().encode(args.body).byteLength,
  };
}

/** What the model and the reviewer are told about this tool. */
const DESCRIPTION =
  "Call an HTTP endpoint. GET/HEAD run directly; other methods are reviewed " +
  "automatically and only risky ones (money, deletion, permissions, outbound " +
  "publishing) wait for the owner. Redirects are not followed: a 3xx comes " +
  "back with its Location. Private and link-local addresses are refused.";

/**
 * Call an HTTP endpoint with any method. Reads go straight through; other
 * methods are reviewed first, and the summary the gate stores has its secret
 * header values masked.
 */
export function httpRequestTool(
  gate: ApprovalGateLike,
  fetchImpl: typeof fetch = fetch,
): ToolRegistration<typeof HttpRequest> {
  return {
    name: "http_request",
    description: DESCRIPTION,
    parameters: HttpRequest,
    structuredOutputSchema: HttpResult,
    replay: "unsafe",
    async execute(args, _api, context): Promise<ToolExecutionResult> {
      context.abortSignal?.throwIfAborted();
      const method = (args.method ?? "GET") as Method;
      const fail = (text: string): ToolExecutionResult => ({
        output: [{ type: "text", text }],
        isError: true,
      });

      let parsed: URL;
      try {
        parsed = new URL(args.url);
      } catch {
        return fail(`无效的 URL：${args.url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return fail(`仅支持 http(s) 链接：${args.url}`);
      }
      if (parsed.username || parsed.password) return fail("URL 不支持内嵌凭据");
      if (READ_ONLY.has(method) && args.body !== undefined) return fail("GET/HEAD 不支持请求体");
      if (isBlockedHost(parsed.hostname)) {
        return fail(`拒绝访问内网地址：${parsed.hostname}`);
      }
      if (args.body !== undefined && new TextEncoder().encode(args.body).byteLength > MAX_REQUEST_BODY_BYTES) {
        return fail(`请求体超过 256 KB`);
      }

      if (!READ_ONLY.has(method)) {
        const decision = await gate.request(
          "http_request",
          redactArgs(args),
          context.abortSignal ?? new AbortController().signal,
          { description: DESCRIPTION },
        );
        if (decision !== "approved") {
          if (context.abortSignal?.aborted) throw context.abortSignal.reason;
          // An error result, not a plain one: a schema tool must return
          // `structuredOutput` unless it is an error, and a script needs the
          // rejection to reject rather than resolve to nothing.
          return {
            output: [{ type: "text", text: rejectionText(decision) }],
            isError: true,
          };
        }
      }

      // Same shape as web-fetch.ts: the tool's own timeout, combined with a
      // caller cancellation when there is one.
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const signal =
        context.abortSignal === undefined
          ? timeout
          : AbortSignal.any([context.abortSignal, timeout]);

      context.abortSignal?.throwIfAborted();
      try {
        const response = await withAbort(() => fetchImpl(parsed.toString(), {
          method,
          headers: args.headers,
          body: method === "GET" || method === "HEAD" ? undefined : args.body,
          redirect: "manual",
          signal,
        }), signal);

      const capped = await readCapped(response, signal);
      const contentType = response.headers.get("content-type") ?? "";
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (name.toLowerCase() !== "set-cookie") headers[name.toLowerCase()] = value;
      });

      // The model sees at most 20 000 characters; a script gets the whole 2 MB
      // the reader kept. Two caps, two audiences, on purpose.
      const bytes = new Uint8Array(await capped.response.arrayBuffer());
      const mime = contentType.split(";")[0]!.trim().toLowerCase();
      const bodyBase64 = !(mime.startsWith("text/") || /json|xml|javascript/.test(mime));
      let raw: string;
      if (bodyBase64) {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        raw = btoa(binary);
      } else {
        raw = new TextDecoder().decode(bytes);
      }
      // A nested result is one SQLite value, and SQLite rows top out at 2 MB.
      // Cap what a script receives well below that, whatever the model reads.
      const scriptBody = raw.length > MAX_SCRIPT_BODY_CHARS ? raw.slice(0, MAX_SCRIPT_BODY_CHARS) : raw;
      const structured = {
        status: response.status,
        contentType,
        headers,
        body: scriptBody,
        bodyBase64,
        truncated: capped.truncated || scriptBody.length < raw.length,
      };

      const body = truncate(raw);
      const location = headers.location;
      const text = [
        `${response.status} ${contentType}${bodyBase64 ? " · base64" : ""}`,
        location === undefined ? "" : `Location: ${location}`,
        capped.truncated ? "（响应超过 2 MB，已截断）" : "",
        "",
        body,
      ]
        .filter((line, index, all) => !(line === "" && index === all.length - 1))
        .join("\n");

      return {
        output: [{ type: "text", text }],
        structuredOutput: structured,
      };
      } catch (error) {
        if (context.abortSignal?.aborted) throw context.abortSignal.reason;
        if (timeout.aborted) return fail("请求超时：超过 30 秒");
        const reason = error instanceof Error ? error.message : String(error);
        return fail(`请求失败：${reason}`);
      }
    },
  };
}
