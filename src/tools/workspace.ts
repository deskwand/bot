import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { createCloudflarePhotonImages } from "@earendil-works/pi-durable/images/cloudflare";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
  type ImageLimits,
  type ImageProcessor,
} from "@earendil-works/pi-durable/tools";
import { INBOUND_IMAGE_LIMITS } from "../channels/media";
import { SKILL_NAME, normalizePath, workspacePrefix } from "../env/r2-env";
import { isAbortError, toolErrorResult } from "./wrap";

/**
 * Every draft workspace tool starts with this: the area is private, capped at
 * 1 MB per file, and not how a task hands anything to the owner.
 */
const WORKSPACE_PREFIX =
  "Private workspace for drafts; the owner never sees these files." +
  " The one exception is /skills/, the shared skill library: files there persist across tasks and every task can read them." +
  " Files over 1 MB are refused. There is no shell; continue long files with offset/limit." +
  " Deliver a final file with save_artifact. ";

const LIST_PAGE_LIMIT = 1000;

const List = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Use /skills or a skill directory to list the shared library; omit for private drafts.",
    }),
  ),
});

/** Resolves the list target, or says why the path is not listable. */
function listTarget(
  taskId: string,
  path: string | undefined,
): { prefix: string; shared: boolean } | string {
  if (path === undefined) return { prefix: workspacePrefix(taskId), shared: false };

  const resolved = normalizePath(path.replace(/\/+$/, ""));
  if (!resolved.ok) {
    return "Only /skills or a skill directory can be listed outside the private workspace"; // i18n-ignore: model-facing
  }
  const segments = resolved.value.split("/").slice(1);
  if (segments[0] === "skills" && segments.length === 1) {
    return { prefix: "skills/", shared: true };
  }
  if (segments[0] !== "skills" || segments.length !== 2) {
    return "Only /skills or a skill directory can be listed outside the private workspace"; // i18n-ignore: model-facing
  }
  if (!SKILL_NAME.test(segments[1]!)) {
    return "That skill directory is not valid"; // i18n-ignore: model-facing
  }
  return { prefix: `skills/${segments[1]!}/`, shared: true };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turn a thrown environment error into a tool result. pi's tools throw on a
 * failed env call; without this the model would see no reason, only a failed
 * task.
 */
function guardExecution<T extends ToolRegistration>(tool: T): T {
  return {
    ...tool,
    async execute(args, api, context) {
      try {
        return await tool.execute(args, api, context);
      } catch (error) {
        if (context.abortSignal?.aborted || isAbortError(error)) throw error;
        return toolErrorResult(error);
      }
    },
  };
}

/** The pi tool, with the workspace label and the error guard applied. */
function workspaceTool<T extends ToolRegistration>(tool: T): T {
  return guardExecution({
    ...tool,
    description: WORKSPACE_PREFIX + tool.description,
  });
}

let decodeProcessor: ImageProcessor | undefined;

/** Photon's wasm instance is expensive; one per isolate is enough. */
function defaultImages(): ImageProcessor {
  return (decodeProcessor ??= createCloudflarePhotonImages());
}

/** Create an image processor only when the first image actually needs one. */
function lazyImages(create: () => ImageProcessor): ImageProcessor {
  let inner: ImageProcessor | undefined;
  return {
    async prepare(bytes, mimeType, limits) {
      inner ??= create();
      return inner.prepare(bytes, mimeType, limits);
    },
  };
}

/** An image processor that never exceeds what an inbound image may be. */
function boundedImages(inner: ImageProcessor): ImageProcessor {
  return {
    async prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits) {
      return inner.prepare(bytes, mimeType, {
        maxWidth: Math.min(limits.maxWidth, INBOUND_IMAGE_LIMITS.maxWidth),
        maxHeight: Math.min(limits.maxHeight, INBOUND_IMAGE_LIMITS.maxHeight),
        maxBytes: Math.min(limits.maxBytes, INBOUND_IMAGE_LIMITS.maxBytes),
      });
    },
  };
}

export function createListTool(
  bucket: R2Bucket,
  taskId: () => string,
  limit: number = LIST_PAGE_LIMIT,
): ToolRegistration<typeof List> {
  return {
    name: "list",
    description:
      "List this task's private drafts, or the shared skills under /skills.",
    parameters: List,
    replay: "safe",
    async execute(args, _api, _context): Promise<ToolExecutionResult> {
      const target = listTarget(taskId(), args.path);
      if (typeof target === "string") {
        return { output: [{ type: "text", text: target }], isError: true };
      }
      const { prefix, shared } = target;
      const lines: string[] = [];
      let cursor: string | undefined;
      let truncated = false;
      try {
        outer: for (;;) {
          const page = await bucket.list({ prefix, cursor });
          for (const object of page.objects) {
            if (lines.length >= limit) {
              truncated = true;
              break outer;
            }
            const name = shared
              ? `/${object.key}`
              : object.key.slice(prefix.length);
            lines.push(
              `${name} · ${object.size} 字节 · ${object.uploaded.toISOString()}`,
            );
          }
          if (!page.truncated || page.cursor === undefined) break;
          cursor = page.cursor;
        }
      } catch (error) {
        return {
          output: [
            {
              type: "text",
              text: shared
                ? `列出技能目录失败：${messageOf(error)}`
                : `列出草稿失败：${messageOf(error)}`,
            },
          ],
          isError: true,
        };
      }
      if (lines.length === 0) {
        return {
          output: [
            {
              type: "text",
              text: shared
                ? `/${prefix.replace(/\/$/, "")} 下没有文件`
                : "草稿区为空",
            },
          ],
        };
      }
      if (truncated) lines.push(`（仅显示前 ${limit} 个）`);
      return { output: [{ type: "text", text: lines.join("\n") }] };
    },
  };
}

/**
 * The draft area's tools: pi's read/write/edit over `work/<taskId>/`, plus a
 * listing of just this task's files.
 */
export function workspaceTools(
  bucket: R2Bucket,
  taskId: () => string,
  /** Decoder for images `read` returns; tests inject one, production uses Photon. */
  images?: ImageProcessor,
  /** Creates the production decoder on first use; tests inject a counter. */
  createDefaultImages: () => ImageProcessor = defaultImages,
): ToolRegistration[] {
  return [
    workspaceTool(
      createReadTool({
        images: boundedImages(
          images ?? lazyImages(createDefaultImages),
        ),
      }),
    ),
    workspaceTool(createWriteTool()),
    workspaceTool(createEditTool()),
    workspaceTool(createListTool(bucket, taskId)),
  ];
}

/** Delete every draft under `work/<taskId>/`; returns how many objects went. */
export async function clearWorkspace(bucket: R2Bucket, taskId: string): Promise<number> {
  const prefix = workspacePrefix(taskId);
  let deleted = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, cursor });
    const keys = page.objects.map((object) => object.key);
    for (let start = 0; start < keys.length; start += LIST_PAGE_LIMIT) {
      const batch = keys.slice(start, start + LIST_PAGE_LIMIT);
      if (batch.length === 0) continue;
      await bucket.delete(batch);
      deleted += batch.length;
    }
    if (!page.truncated || page.cursor === undefined) break;
    cursor = page.cursor;
  }
  return deleted;
}
