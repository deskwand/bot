import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

const SaveArtifact = Type.Object({
  filename: Type.String(),
  content: Type.String(),
  contentType: Type.Optional(Type.String()),
});

const DEFAULT_CONTENT_TYPE = "text/markdown; charset=utf-8";

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

      const key = `${id}/${crypto.randomUUID()}/${filename}`;
      await bucket.put(key, content, {
        httpMetadata: {
          contentType: contentType ?? DEFAULT_CONTENT_TYPE,
        },
      });

      const url = `${baseUrl}/a/${key}`;
      return { output: [{ type: "text", text: `已保存：${url}` }] };
    },
  };
}
