import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { readCapped, truncate } from "./http-body";

const GetArtifact = Type.Object({
  ref: Type.String(),
});

const ARTIFACT_PATH = "/a/";

/** Progress and logs never carry a query string or credentials from a ref. */
export function safeArtifactRef(
  ref: string,
  invalidLabel = "[无效 URL]", // i18n-ignore: default for model-facing callers
): string {
  if (!/^https?:\/\//i.test(ref)) return ref;
  try {
    const url = new URL(ref);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return invalidLabel;
  }
}

/**
 * Normalize a public artifact URL or a bare R2 key into the key. Decodes each
 * URL segment exactly once; bare keys stay literal, so percent escapes
 * in the key survive. Returns null for anything that could escape the prefix.
 */
export function artifactKeyFromRef(ref: string, baseUrl: string): string | null {
  let path = ref;
  const isUrl = /^https?:\/\//i.test(ref);
  if (isUrl) {
    try {
      const base = new URL(baseUrl);
      const url = new URL(ref);
      if (url.origin !== base.origin || url.username || url.password) return null;
      // Read the raw path: URL.pathname normalizes encoded dot segments away.
      const rawPath = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(ref)?.[1] ?? "";
      const prefix = `${base.pathname.replace(/\/$/, "")}${ARTIFACT_PATH}`;
      if (!rawPath.startsWith(prefix)) return null;
      path = rawPath.slice(prefix.length);
    } catch {
      return null;
    }
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref)) {
    return null;
  }

  let segments: string[];
  try {
    // Bare keys are already literal R2 keys; only URLs are percent-encoded.
    segments = path.split("/").map((segment) => isUrl ? decodeURIComponent(segment) : segment);
  } catch {
    return null;
  }

  if (segments.length !== 3 || segments.some((segment) =>
    segment === "" || segment === "." || segment === ".." || /[/\\\x00-\x1f\x7f]/.test(segment)
  )) return null;
  return segments.join("/");
}

/**
 * Read an artifact back. `save_artifact` stores under `${taskId}/${fileId}/
 * ${name}` and returns only a URL, so without this a task cannot re-read what
 * it wrote except by fetching its own public link through the readability
 * extractor, which rewrites markdown and cannot carry binary.
 */
export function getArtifactTool(
  bucket: R2Bucket,
  baseUrl: string,
): ToolRegistration<typeof GetArtifact> {
  return {
    name: "get_artifact",
    description:
      "Read a file previously saved with `save_artifact`. Pass its public URL " +
      "or its key (`<taskId>/<fileId>/<name>`).",
    parameters: GetArtifact,
    replay: "safe",
    async execute({ ref }): Promise<ToolExecutionResult> {
      const key = artifactKeyFromRef(ref, baseUrl);
      if (key === null) {
        return { output: [{ type: "text", text: `无效的产物引用：${ref}` }], isError: true };
      }

      const object = await bucket.get(key);
      if (!object) {
        return { output: [{ type: "text", text: `没有这个产物：${key}` }], isError: true };
      }

      const contentType = object.httpMetadata?.contentType ?? "application/octet-stream";
      // Stream through the shared 2 MB cap; never materialize the whole object.
      const capped = await readCapped(new Response(object.body));
      const bytes = new Uint8Array(await capped.response.arrayBuffer());
      const header = `${contentType} · ${object.size} 字节\n\n`;
      const readNote = capped.truncated ? "\n\n[内容超过 2 MB，已截断]" : "";

      const mime = contentType.split(";")[0]!.trim().toLowerCase();
      if (mime.startsWith("text/") || /json|xml|javascript/.test(mime)) {
        const text = new TextDecoder().decode(bytes);
        return { output: [{ type: "text", text: header + truncate(text) + readNote }] };
      }

      // Binary comes back base64 with an explicit label so a script knows what
      // it is holding; nothing here decodes images.
      const shown = bytes.subarray(0, 15_000); // base64 <= 20 000 characters
      let binary = "";
      for (const byte of shown) binary += String.fromCharCode(byte);
      const base64 = btoa(binary);
      const note = object.size > shown.byteLength ? "（base64 仅含前 15000 字节，已截断）" : "";
      return {
        output: [{ type: "text", text: `${header}base64${note}\n\n${base64}` }],
      };
    },
  };
}
