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
import { workspacePrefix } from "../env/r2-env";

/**
 * Every draft workspace tool starts with this: the area is private, capped at
 * 1 MB per file, and not how a task hands anything to the owner.
 */
const WORKSPACE_PREFIX =
  "Private workspace for drafts; the owner never sees these files." +
  " Files over 1 MB are refused. Deliver a final file with save_artifact. ";

const LIST_PAGE_LIMIT = 1000;

const List = Type.Object({});

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
        if (context.abortSignal?.aborted) throw error;
        return {
          output: [{ type: "text", text: `工具出错：${messageOf(error)}` }],
          isError: true,
        };
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

/** An image processor that never exceeds what an inbound image may be. */
function workspaceImages(): ImageProcessor {
  const photon = createCloudflarePhotonImages();
  return {
    async prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits) {
      return photon.prepare(bytes, mimeType, {
        maxWidth: Math.min(limits.maxWidth, INBOUND_IMAGE_LIMITS.maxWidth),
        maxHeight: Math.min(limits.maxHeight, INBOUND_IMAGE_LIMITS.maxHeight),
        maxBytes: Math.min(limits.maxBytes, INBOUND_IMAGE_LIMITS.maxBytes),
      });
    },
  };
}

function listTool(bucket: R2Bucket, taskId: () => string): ToolRegistration<typeof List> {
  return {
    name: "list",
    description: "List the files in this task's private workspace.",
    parameters: List,
    replay: "safe",
    async execute(_args, _api, _context): Promise<ToolExecutionResult> {
      const prefix = workspacePrefix(taskId());
      const lines: string[] = [];
      let cursor: string | undefined;
      try {
        while (lines.length < LIST_PAGE_LIMIT) {
          const page = await bucket.list({ prefix, cursor });
          for (const object of page.objects) {
            if (lines.length >= LIST_PAGE_LIMIT) break;
            lines.push(
              `${object.key.slice(prefix.length)} · ${object.size} 字节 · ${object.uploaded.toISOString()}`,
            );
          }
          if (!page.truncated || page.cursor === undefined) break;
          cursor = page.cursor;
        }
      } catch (error) {
        return {
          output: [{ type: "text", text: `列出草稿失败：${messageOf(error)}` }],
          isError: true,
        };
      }
      if (lines.length === 0) {
        return { output: [{ type: "text", text: "草稿区为空" }] };
      }
      return { output: [{ type: "text", text: lines.join("\n") }] };
    },
  };
}

/**
 * The draft area's tools: pi's read/write/edit over `work/<taskId>/`, plus a
 * listing of just this task's files.
 */
export function workspaceTools(bucket: R2Bucket, taskId: () => string): ToolRegistration[] {
  return [
    workspaceTool(createReadTool({ images: workspaceImages() })),
    workspaceTool(createWriteTool()),
    workspaceTool(createEditTool()),
    listTool(bucket, taskId),
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
