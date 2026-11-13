import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { ArtifactStore } from "../artifact-store";
import { readCapped, truncate } from "./http-body";
import { MAX_ARTIFACT_BYTES, artifactKeySegments, artifactNameFromKey } from "../artifact";
import {
  callAcceptsImages,
  classifyFile,
  renderFile,
  type DocumentConverter,
} from "./file-content";

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

  // Bare keys are already literal R2 keys; only URL paths are percent-encoded.
  let decoded = path;
  if (isUrl) {
    try {
      decoded = path.split("/").map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
      return null;
    }
  }
  return artifactKeySegments(decoded) === null ? null : decoded;
}

/**
 * Read an artifact back. `save_artifact` stores under `${taskId}/${fileId}/
 * ${name}` and returns only a URL, so without this a task cannot re-read what
 * it wrote except by fetching its own public link through the readability
 * extractor, which rewrites markdown and cannot carry binary.
 */
export function getArtifactTool(
  bucket: ArtifactStore,
  baseUrl: string,
  options: {
    taskId: () => string;
    /** Inbox keys the owner attached to this task; readable besides its own artifacts. */
    attachments?: () => readonly string[];
    convert?: DocumentConverter;
  },
): ToolRegistration<typeof GetArtifact> {
  return {
    name: "get_artifact",
    description:
      "Read a saved file by its key: files saved by this task (`<taskId>/<fileId>/<name>`)" +
      " or the owner's files listed in this task's attachments (`inbox/...` keys)." +
      " Text comes back as text, PDF and Office files as Markdown, images as images.",
    parameters: GetArtifact,
    replay: "safe",
    async execute({ ref }, api, context): Promise<ToolExecutionResult> {
      const key = artifactKeyFromRef(ref, baseUrl);
      if (key === null) {
        return { output: [{ type: "text", text: `无效的产物引用：${ref}` }], isError: true };
      }

      const segments = artifactKeySegments(key);
      const attached = segments !== null && (options.attachments?.() ?? []).includes(key);
      if (segments === null || (segments[0] !== options.taskId() && !attached)) {
        return { output: [{ type: "text", text: `无权读取这个产物：${key}` }], isError: true };
      }

      const object = await bucket.get(key);
      if (!object) {
        return { output: [{ type: "text", text: `没有这个产物：${key}` }], isError: true };
      }

      const contentType = object.httpMetadata?.contentType ?? "application/octet-stream";
      const name = artifactNameFromKey(key);
      const header = `${contentType} · ${object.size} 字节\n\n`;

      const render = (bytes: Uint8Array, kind: "image" | "document", mimeType: string) =>
        renderFile(
          { bytes, name, mimeType, kind, header },
          {
            convert: options.convert,
            acceptsImages: () => callAcceptsImages(api, context),
          },
        );

      const raw = (bytes: Uint8Array, truncated: boolean): ToolExecutionResult => {
        const readNote = truncated ? "\n\n[内容超过 2 MB，已截断]" : "";
        const mime = contentType.split(";")[0]!.trim().toLowerCase();
        if (mime.startsWith("text/") || /json|xml|javascript/.test(mime)) {
          const text = new TextDecoder().decode(bytes);
          return { output: [{ type: "text", text: header + truncate(text) + readNote }] };
        }

        // Binary comes back base64 with an explicit label so a script knows what
        // it is holding.
        const shown = bytes.subarray(0, 15_000); // base64 <= 20 000 characters
        let binary = "";
        for (const byte of shown) binary += String.fromCharCode(byte);
        const base64 = btoa(binary);
        const note = object.size > shown.byteLength ? "（base64 仅含前 15000 字节，已截断）" : "";
        return {
          output: [{ type: "text", text: `${header}base64${note}\n\n${base64}` }],
        };
      };

      // Documents within the artifact limit skip the 2 MB cap so a conversion
      // sees the whole file, not its first half.
      const declared = classifyFile(undefined, contentType, name);
      if (
        (declared.kind === "image" || declared.kind === "document") &&
        object.size <= MAX_ARTIFACT_BYTES
      ) {
        const bytes = new Uint8Array(await object.arrayBuffer());
        const confirmed = classifyFile(bytes, contentType, name);
        // A declared image/* whose bytes are not a known image is just binary.
        const sniffed = classifyFile(bytes, "application/octet-stream", name);
        const kind =
          confirmed.kind === "image" && sniffed.kind !== "image" ? "other" : confirmed.kind;
        if (kind !== "other") {
          return render(
            bytes,
            kind,
            kind === "image" ? sniffed.mimeType : confirmed.mimeType,
          );
        }
        return raw(bytes, false);
      }

      // Stream through the shared 2 MB cap; never materialize the whole object.
      const capped = await readCapped(new Response(object.body));
      const bytes = new Uint8Array(await capped.response.arrayBuffer());

      // A small octet-stream can still be a PDF or an image; a truncated read
      // would only hand the converter half a file.
      if (!capped.truncated) {
        const sniffed = classifyFile(bytes, contentType, name);
        if (sniffed.kind === "image" || sniffed.kind === "document") {
          return render(bytes, sniffed.kind, sniffed.mimeType);
        }
      }

      return raw(bytes, capped.truncated);
    },
  };
}
