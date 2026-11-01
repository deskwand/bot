import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";

const Fetch = Type.Object({
  url: Type.String(),
});

const FETCH_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 20_000;
const TRUNCATION_MARKER = "\n\n[已截断]";

function textResult(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      reject(new Error("已取消"));
      return;
    }
    const onAbort = () => reject(new Error("已取消"));
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    return await Promise.race([fetchImpl(url, { signal }), aborted]);
  } finally {
    cleanup();
  }
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
        return textResult(`读取失败：${errorMessage(error)}`);
      }

      if (!response.ok) {
        return textResult(`读取失败：HTTP ${response.status}`);
      }

      const contentType = (
        response.headers.get("content-type") ?? ""
      ).toLowerCase();
      const mime = contentType.split(";")[0]!.trim();

      if (mime === "text/html" || mime === "application/xhtml+xml") {
        const html = await extractHtml(response);
        return textResult(truncate(html.replace(/\s+/g, " ").trim()));
      }

      if (
        mime.startsWith("text/") ||
        mime === "application/json" ||
        mime.endsWith("+json")
      ) {
        return textResult(truncate(await response.text()));
      }

      return textResult(`不支持的内容类型：${mime || "未知"}`);
    },
  };
}
