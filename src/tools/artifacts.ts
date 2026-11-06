import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { MAX_ARTIFACT_BYTES, sanitizeFilename } from "../artifact";
import { normalizePath, workspacePrefix } from "../env/r2-env";
import { classifyFile, extensionForMime } from "./file-content";
import { withAbort } from "./http-body";
import { isBlockedHost } from "./http-request";

const SaveArtifact = Type.Object({
  filename: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  /** 草稿区里的路径，例如 "report.md"；无需把内容再发一遍。 */
  draft: Type.Optional(Type.String()),
  contentType: Type.Optional(Type.String()),
  /** `base64` 时先把 content 解成字节再落盘，用于图片等二进制产物。 */
  encoding: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("base64")])),
});

const DEFAULT_CONTENT_TYPE = "text/markdown; charset=utf-8";
const DOWNLOAD_CONTENT_TYPE = "application/octet-stream";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const TOO_LARGE = "文件超过 15 MB，无法作为产物发送；请拆分成多个文件或只保留摘要";
const DOWNLOAD_TOO_LARGE = "远程文件超过 15 MB，无法下载";

function fail(text: string): ToolExecutionResult {
  return { output: [{ type: "text" as const, text }], isError: true };
}

/**
 * Pick a name for a downloaded file. RFC 6266's `filename*` wins over the
 * plain `filename`, then the final URL path segment, then a generic fallback.
 */
export function filenameFromResponse(response: Response, url: URL): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const extended = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(disposition);
  if (extended?.[1]) {
    const raw = extended[1].trim().replace(/^"|"$/g, "");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition);
  if (plain) {
    const raw = (plain[1] ?? plain[2] ?? "").trim();
    if (raw) return raw;
  }

  const last = url.pathname.split("/").filter(Boolean).pop();
  if (last) {
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  }
  return "download";
}

async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array } | { error: string }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0) };

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await withAbort(() => reader.read(), signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_ARTIFACT_BYTES) {
        await reader.cancel().catch(() => {});
        return { error: DOWNLOAD_TOO_LARGE };
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

/**
 * Store a file in R2 and return a public link. `taskId` is a getter because
 * tools are installed before the DO knows which task it will run.
 */
export function saveArtifactTool(
  bucket: R2Bucket,
  taskId: () => string,
  guard?: () => Promise<void>,
  fetchImpl: typeof fetch = fetch,
): ToolRegistration<typeof SaveArtifact> {
  return {
    name: "save_artifact",
    description:
      "Save a file so it can be shared with the user. Pass `content` to write text or base64, or `url` to download a file (up to 15 MB) without reading it into the conversation. Pass `draft` to deliver a file from your private workspace without re-sending its content. The returned key can be read back with get_artifact; use url for web files over 2 MB.",
    parameters: SaveArtifact,
    async execute({ filename, content, url, draft, contentType, encoding }, _api, context) {
      const hasContent = content !== undefined;
      const hasUrl = url !== undefined;
      const hasDraft = draft !== undefined;
      const sources = [hasContent, hasUrl, hasDraft].filter(Boolean).length;
      if (sources !== 1) return fail("content、url、draft 必须且只能给一个");
      if (hasContent && !filename) return fail("保存 content 时必须给 filename");

      // A backup/restore lease fences artifact writes so the R2 listing and
      // the write-back cannot miss a file created halfway through the export.
      if (guard) await guard();
      const id = taskId();
      if (!id) throw new Error("任务尚未开始");

      let body: string | Uint8Array;
      let name: string;
      let resolvedType: string;

      if (hasContent) {
        body = content!;
        name = filename!;
        resolvedType = contentType ?? DEFAULT_CONTENT_TYPE;

        if (encoding === "base64") {
          try {
            const binary = atob(content!);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            body = bytes;
          } catch {
            return fail(
              "content 不是有效的 base64；二进制产物请用 encoding: \"base64\" 并传标准 base64 文本",
            );
          }
        }

        // The cap is enforced here: a stored file always has a delivery path,
        // so anything the channel could not carry must be refused up front.
        const bytes = body instanceof Uint8Array
          ? body.byteLength
          : new TextEncoder().encode(body).byteLength;
        if (bytes > MAX_ARTIFACT_BYTES) return fail(TOO_LARGE);
      } else if (hasUrl) {
        let parsed: URL;
        try {
          parsed = new URL(url!);
        } catch {
          return fail(`无效的 URL：${url}`);
        }

        const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
        const signal = context.abortSignal
          ? AbortSignal.any([context.abortSignal, timeout])
          : timeout;

        let current = parsed;
        let response: Response;
        for (let hop = 0; ; hop++) {
          if (current.protocol !== "http:" && current.protocol !== "https:") {
            return fail(`仅支持 http(s) 链接：${current.toString()}`);
          }
          if (current.username || current.password) {
            return fail("URL 不支持内嵌凭据");
          }
          if (isBlockedHost(current.hostname)) {
            return fail(`拒绝访问内网地址：${current.hostname}`);
          }

          try {
            response = await withAbort(
              () => fetchImpl(current.toString(), { redirect: "manual", signal }),
              signal,
            );
          } catch (error) {
            // Caller cancellation must propagate so the run stops; only the
            // tool's own timeout becomes a normal answer.
            if (context.abortSignal?.aborted) throw context.abortSignal.reason;
            if (timeout.aborted) return fail("下载超时：超过 60 秒");
            const reason = error instanceof Error ? error.message : String(error);
            return fail(`下载失败：${reason}`);
          }

          const location = response.headers.get("location");
          if (response.status >= 300 && response.status < 400 && location) {
            void response.body?.cancel().catch(() => {});
            if (hop >= MAX_REDIRECTS) return fail("重定向次数过多");
            try {
              current = new URL(location, current);
            } catch {
              return fail(`无效的重定向地址：${location}`);
            }
            continue;
          }
          break;
        }

        if (!response.ok) return fail(`下载失败：HTTP ${response.status}`);

        const declared = response.headers.get("content-length");
        if (declared !== null) {
          const length = Number(declared);
          if (Number.isFinite(length) && length > MAX_ARTIFACT_BYTES) {
            await response.body?.cancel().catch(() => {});
            return fail(DOWNLOAD_TOO_LARGE);
          }
        }

        try {
          const read = await readBody(response, signal);
          if ("error" in read) return fail(read.error);
          body = read.bytes;
        } catch (error) {
          if (context.abortSignal?.aborted) throw context.abortSignal.reason;
          if (timeout.aborted) return fail("下载超时：超过 60 秒");
          const reason = error instanceof Error ? error.message : String(error);
          return fail(`下载失败：${reason}`);
        }

        name = filename || filenameFromResponse(response, current);
        const responseType = response.headers.get("content-type");
        const file = classifyFile(body, responseType ?? "", name);
        const declaredType = (responseType ?? "").split(";")[0]!.trim().toLowerCase();
        resolvedType = contentType ?? responseType ?? DOWNLOAD_CONTENT_TYPE;

        // A generic octet-stream hides the real type; trust the bytes instead.
        if (
          !contentType &&
          (file.kind === "document" || file.kind === "image") &&
          (declaredType === "" || declaredType === DOWNLOAD_CONTENT_TYPE)
        ) {
          resolvedType = file.mimeType;
        }

        // The name is what a later get_artifact uses to classify the object,
        // so a sniffed document or image must carry its extension.
        if (file.kind === "document" || file.kind === "image") {
          const extension = extensionForMime(resolvedType);
          if (extension && !name.toLowerCase().endsWith(`.${extension}`)) {
            name = `${name}.${extension}`;
          }
        }
      } else {
        const draftPath = draft!;
        const resolved = normalizePath(draftPath);
        if (!resolved.ok) return fail(resolved.error.message);
        const virtualPath = resolved.value;
        const key = workspacePrefix(id) + virtualPath.slice(1);
        const object = await bucket.get(key);
        if (object === null) return fail(`草稿不存在：${draftPath}`);
        if (object.size > MAX_ARTIFACT_BYTES) return fail(TOO_LARGE);
        body = new Uint8Array(await object.arrayBuffer());
        name = filename || virtualPath.slice(virtualPath.lastIndexOf("/") + 1);

        const inferred = classifyFile(body, "", name);
        resolvedType =
          contentType ??
          (inferred.mimeType && inferred.mimeType !== DOWNLOAD_CONTENT_TYPE
            ? inferred.mimeType
            : DEFAULT_CONTENT_TYPE);
      }

      // The export may have started while we were downloading; re-check the
      // lease so this write cannot slip past it.
      if (hasUrl && guard) await guard();

      const finalName = sanitizeFilename(name);
      const fileId = crypto.randomUUID();
      const key = `${id}/${fileId}/${finalName}`;
      await bucket.put(key, body, {
        httpMetadata: {
          contentType: resolvedType || DOWNLOAD_CONTENT_TYPE,
        },
      });

      return { output: [{ type: "text" as const, text: `已保存：${key}` }] };
    },
  };
}
