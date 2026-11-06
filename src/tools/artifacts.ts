import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { MAX_ARTIFACT_BYTES } from "../artifact";

const SaveArtifact = Type.Object({
  filename: Type.String(),
  content: Type.String(),
  contentType: Type.Optional(Type.String()),
  /** `base64` 时先把 content 解成字节再落盘，用于图片等二进制产物。 */
  encoding: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("base64")])),
});

const DEFAULT_CONTENT_TYPE = "text/markdown; charset=utf-8";

// ASCII letters/digits plus the CJK/Hangul/kana ranges; everything else
// becomes "_" so a filename cannot escape its key prefix.
const INVALID_FILENAME_CHARS =
  /[^A-Za-z0-9._\-\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;

function sanitizeFilename(raw: string): string {
  // Strip any path segments, including Windows separators.
  const basename = raw.split(/[/\\]/).pop() ?? "";
  const name = basename
    .replace(/\.\./g, "_")
    .replace(INVALID_FILENAME_CHARS, "_");
  return name === "" || name === "." || name === ".." ? "artifact" : name;
}

/**
 * Store a file in R2 and return a public link. `taskId` is a getter because
 * tools are installed before the DO knows which task it will run.
 */
export function saveArtifactTool(
  bucket: R2Bucket,
  taskId: () => string,
  guard?: () => Promise<void>,
): ToolRegistration<typeof SaveArtifact> {
  return {
    name: "save_artifact",
    description: "Save a file so it can be shared with the user.",
    parameters: SaveArtifact,
    async execute({ filename, content, contentType, encoding }) {
      // A backup/restore lease fences artifact writes so the R2 listing and
      // the write-back cannot miss a file created halfway through the export.
      if (guard) await guard();
      const id = taskId();
      if (!id) throw new Error("任务尚未开始");

      let body: string | Uint8Array = content;
      if (encoding === "base64") {
        try {
          const binary = atob(content);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          body = bytes;
        } catch {
          return {
            output: [
              {
                type: "text" as const,
                text: "content 不是有效的 base64；二进制产物请用 encoding: \"base64\" 并传标准 base64 文本",
              },
            ],
            isError: true,
          };
        }
      }

      // The cap is enforced here: a stored file always has a delivery path,
      // so anything the channel could not carry must be refused up front.
      const bytes = body instanceof Uint8Array ? body.byteLength : new TextEncoder().encode(body).byteLength;
      if (bytes > MAX_ARTIFACT_BYTES) {
        return {
          output: [
            {
              type: "text" as const,
              text: "文件超过 15 MB，无法作为产物发送；请拆分成多个文件或只保留摘要",
            },
          ],
          isError: true,
        };
      }

      const name = sanitizeFilename(filename);
      const fileId = crypto.randomUUID();
      const key = `${id}/${fileId}/${name}`;
      await bucket.put(key, body, {
        httpMetadata: {
          contentType: contentType ?? DEFAULT_CONTENT_TYPE,
        },
      });

      return { output: [{ type: "text" as const, text: `已保存：${key}` }] };
    },
  };
}
