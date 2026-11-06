import { BODY_TRUNCATION_MARKER, readCapped, truncate } from "./http-body";
import { callAcceptsImages, classifyFile, renderFile, type DocumentConverter } from "./file-content";
import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";

const Fetch = Type.Object({
  url: Type.String(),
});

const FETCH_TIMEOUT_MS = 30_000;

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

/** Fetch a URL and return readable content. Read-only, so safe to replay. */
export function webFetchTool(
  fetchImpl: typeof fetch = fetch,
  convert?: DocumentConverter,
): ToolRegistration<typeof Fetch> {
  return {
    name: "web_fetch",
    description: "Fetch a URL over GET and return its readable content: web pages as text, PDF and Office files as Markdown, images as images. Read-only: no custom method, headers or body. Use another tool for writes.",
    parameters: Fetch,
    replay: "safe",
    async execute({ url }, api, context) {
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

      const bytes = new Uint8Array(await capped.response.arrayBuffer());
      const name = parsed.pathname.split("/").pop() || "download";
      const file = classifyFile(bytes, mime, name);
      if (file.kind === "image" || file.kind === "document") {
        if (capped.truncated) {
          return textResult(
            "文件超过 2 MB，web_fetch 读不全；请用 save_artifact 的 url 参数下载，再用 get_artifact 读取",
          );
        }
        return renderFile(
          {
            bytes,
            name,
            mimeType: file.mimeType,
            kind: file.kind,
            header: `${mime} · ${bytes.byteLength} 字节\n\n`,
          },
          {
            convert,
            acceptsImages: () => callAcceptsImages(api, context),
          },
        );
      }

      return textResult(`不支持的内容类型：${mime || "未知"}`);
    },
  };
}
