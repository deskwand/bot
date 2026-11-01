import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";

const Fetch = Type.Object({
  url: Type.String(),
});

const FETCH_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER = "\n\n[已截断]";
const BODY_TRUNCATION_MARKER = "\n\n[内容超过 2 MB，已截断]";

function textResult(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function truncate(text: string): string {
  return text.length <= MAX_TEXT_CHARS
    ? text
    : text.slice(0, MAX_TEXT_CHARS) + TRUNCATION_MARKER;
}

async function fetchWithAbort(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  let cleanup = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    return await Promise.race([fetchImpl(url, { signal }), aborted]);
  } finally {
    cleanup();
  }
}

/**
 * Read at most 2 MB from the response. Streaming stops early so a huge body
 * cannot exhaust the Worker's memory; the caller notes the truncation.
 */
async function readCapped(
  response: Response,
): Promise<{ response: Response; truncated: boolean }> {
  if (!response.body) return { response, truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (total + value.byteLength > MAX_BODY_BYTES) {
        const remaining = MAX_BODY_BYTES - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        truncated = true;
        break;
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  return {
    response: new Response(new Blob(chunks), {
      status: response.status,
      headers: response.headers,
    }),
    truncated,
  };
}

async function extractHtml(response: Response): Promise<string> {
  // Two passes: remove unwanted elements first, then collect text. A single
  // pass would still feed text handlers the contents of removed elements.
  const stripped = await new HTMLRewriter()
    .on("script, style, nav, footer", {
      element(element) {
        element.remove();
      },
    })
    .transform(response)
    .text();

  let text = "";
  await new HTMLRewriter()
    .on("body", {
      text(chunk) {
        text += chunk.text;
      },
    })
    .transform(new Response(stripped))
    .text();
  return text;
}

/** Fetch a URL and return readable text. Read-only, so safe to replay. */
export function webFetchTool(
  fetchImpl: typeof fetch = fetch,
): ToolRegistration<typeof Fetch> {
  return {
    name: "web_fetch",
    description: "Fetch a web page and return its readable text.",
    parameters: Fetch,
    replay: "safe",
    async execute({ url }, _api, context) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return textResult(`无效的 URL：${url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return textResult(`仅支持 http(s) 链接：${url}`);
      }

      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const signal = context.abortSignal
        ? AbortSignal.any([context.abortSignal, timeout])
        : timeout;

      let response: Response;
      try {
        response = await fetchWithAbort(fetchImpl, url, signal);
      } catch (error) {
        // Caller cancellation must propagate so the run stops; only the
        // tool's own timeout becomes a normal "timed out" answer.
        if (context.abortSignal?.aborted) throw error;
        if (timeout.aborted) {
          return textResult(
            `读取超时：超过 ${FETCH_TIMEOUT_MS / 1000} 秒`,
          );
        }
        return textResult(`读取失败：${errorMessage(error)}`);
      }

      if (!response.ok) {
        return textResult(`读取失败：HTTP ${response.status}`);
      }

      const contentType = (
        response.headers.get("content-type") ?? ""
      ).toLowerCase();
      const mime = contentType.split(";")[0]!.trim();

      const capped = await readCapped(response);
      const note = capped.truncated ? BODY_TRUNCATION_MARKER : "";

      if (mime === "text/html" || mime === "application/xhtml+xml") {
        const html = await extractHtml(capped.response);
        return textResult(
          truncate(html.replace(/\s+/g, " ").trim()) + note,
        );
      }

      if (
        mime.startsWith("text/") ||
        mime === "application/json" ||
        mime.endsWith("+json")
      ) {
        return textResult(truncate(await capped.response.text()) + note);
      }

      return textResult(`不支持的内容类型：${mime || "未知"}`);
    },
  };
}
