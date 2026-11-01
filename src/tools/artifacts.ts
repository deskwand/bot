import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

const SaveArtifact = Type.Object({
  filename: Type.String(),
  content: Type.String(),
  contentType: Type.Optional(Type.String()),
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
  baseUrl: string,
): ToolRegistration<typeof SaveArtifact> {
  return {
    name: "save_artifact",
    description: "Save a file so it can be shared with the user.",
    parameters: SaveArtifact,
    async execute({ filename, content, contentType }) {
      const id = taskId();
      if (!id) throw new Error("任务尚未开始");

      const name = sanitizeFilename(filename);
      const fileId = crypto.randomUUID();
      const key = `${id}/${fileId}/${name}`;
      await bucket.put(key, content, {
        httpMetadata: {
          contentType: contentType ?? DEFAULT_CONTENT_TYPE,
        },
      });

      const path = [id, fileId, name].map(encodeURIComponent).join("/");
      const url = `${baseUrl}/a/${path}`;
      return { output: [{ type: "text", text: `已保存：${url}` }] };
    },
  };
}
