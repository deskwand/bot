import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ArtifactStore } from "../artifact-store";
import { nowTool } from "../tools/now";
import { getArtifactTool } from "../tools/get-artifact";
import { saveArtifactTool } from "../tools/artifacts";
import type { DocumentConverter } from "../tools/file-content";
import { webSearchTool } from "../tools/web-search";
import { workspaceTools } from "../tools/workspace";

/**
 * What a member task may touch in the artifact store: its own outputs, its own
 * draft area and the attachments the owner gave it. Everything else — other
 * tasks' outputs, the inbox at large and the shared skill library — is denied.
 */
export type MemberStoreScope = {
  taskId: () => string;
  attachments: () => readonly string[];
};

const DENIED_KEY = "member task scope: key denied";

/**
 * A rejecting view of the artifact store. Reads outside the scope answer as a
 * missing object, so a denied path is indistinguishable from an absent one and
 * a model cannot probe the deployment by trying keys. Writes outside the scope
 * throw: they are always a scoping bug, never a legitimate miss.
 */
export function memberArtifactStore(
  bucket: ArtifactStore,
  scope: MemberStoreScope,
): ArtifactStore {
  const roots = (): string[] => {
    const taskId = scope.taskId();
    return taskId === "" ? [] : [`${taskId}/`, `work/${taskId}/`];
  };
  const writable = (key: string): boolean =>
    roots().some((root) => key.startsWith(root));
  const readable = (key: string): boolean =>
    writable(key) || scope.attachments().includes(key);

  // A list prefix is readable when it can only select readable keys: either it
  // narrows one of the roots, or it is a prefix of an attachment key.
  const readablePrefix = (prefix: string): boolean => {
    if (prefix === "") return true;
    const listed = roots();
    if (listed.some((root) => root.startsWith(prefix))) return true;
    if (listed.some((root) => prefix.startsWith(root))) return true;
    return scope.attachments().some((key) => key.startsWith(prefix));
  };

  const deny = (operation: string, key: string): void => {
    console.warn(
      `member task ${scope.taskId()}: ${operation} denied for ${key}`,
    );
  };

  return {
    async head(key) {
      if (!readable(key)) {
        deny("head", key);
        return null;
      }
      return await bucket.head(key);
    },

    async get(key, options) {
      if (!readable(key)) {
        deny("get", key);
        return null;
      }
      return await bucket.get(key, options);
    },

    async put(key, value, options) {
      if (!writable(key)) {
        deny("put", key);
        throw new Error(DENIED_KEY);
      }
      return await bucket.put(key, value, options);
    },

    async delete(keys) {
      const requested = typeof keys === "string" ? [keys] : keys;
      for (const key of requested) {
        if (!writable(key)) {
          deny("delete", key);
          throw new Error(DENIED_KEY);
        }
      }
      await bucket.delete(keys);
    },

    async list(options) {
      const prefix = options?.prefix ?? "";
      if (!readablePrefix(prefix)) return { objects: [], truncated: false };
      const page = await bucket.list(options);
      return {
        objects: page.objects.filter((object) => readable(object.key)),
        truncated: page.truncated,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      };
    },
  };
}

/**
 * `save_artifact` without the download path. A member task may write bytes it
 * holds, but fetching a URL would turn the task into a general-purpose proxy.
 */
const MemberSaveArtifact = Type.Object({
  filename: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  draft: Type.Optional(Type.String()),
  contentType: Type.Optional(Type.String()),
  encoding: Type.Optional(
    Type.Union([Type.Literal("text"), Type.Literal("base64")]),
  ),
});

const MEMBER_URL_REFUSED =
  "A member task cannot download a url; pass content or a draft path instead"; // i18n-ignore: model-facing

export type MemberToolDeps = {
  env: Env;
  taskId: () => string;
  attachments: () => readonly string[];
  /** The scoped view; every member tool reads and writes through it. */
  store: ArtifactStore;
  /** Fences artifact writes during a backup/restore lease. */
  guard?: () => Promise<void>;
  convert?: DocumentConverter;
  /** The TaskDO-owned `finish_task`; it resolves artifacts through the scope. */
  finish: ToolRegistration;
};

/**
 * The whole execution surface of a member task: search, clock, its own files
 * and completion. No sandbox, no HTTP, no mail, no MCP, no bots, no wallet.
 */
export function memberTaskTools(deps: MemberToolDeps): ToolRegistration[] {
  const save = saveArtifactTool(deps.store, deps.taskId, deps.guard);
  const inlineSave: ToolRegistration = {
    ...save,
    parameters: MemberSaveArtifact,
    async execute(args, api, context) {
      if (args !== null && typeof args === "object" && "url" in args) {
        return {
          output: [{ type: "text" as const, text: MEMBER_URL_REFUSED }],
          isError: true,
        };
      }
      return save.execute(args as never, api, context);
    },
  };

  return [
    webSearchTool(deps.env),
    nowTool(),
    getArtifactTool(deps.store, deps.env.PUBLIC_BASE_URL, {
      taskId: deps.taskId,
      attachments: deps.attachments,
      convert: deps.convert,
    }),
    inlineSave,
    ...workspaceTools(deps.store, deps.taskId),
    deps.finish,
  ];
}
