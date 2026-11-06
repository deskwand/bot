import type { Context } from "@earendil-works/chord";
import {
  ExecutionError,
  FileError,
  LineScanner,
  err,
  ok,
  type BinaryReader,
  type ExecutionEnv,
  type FileInfo,
  type Result,
} from "@earendil-works/pi-durable/env";

/** Largest draft a task may write, measured in UTF-8 bytes. */
export const MAX_DRAFT_BYTES = 1 << 20;

/** R2 prefix holding one task's drafts. */
export function workspacePrefix(taskId: string): string {
  return `work/${taskId}/`;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ARTIFACT_TASK_SEGMENT = /^t\d+$/;

function invalid(message: string, path: string): FileError {
  return new FileError("invalid", message, path);
}

/** Map a tool path onto the environment's virtual root and reject anything that leaves it. */
export function normalizePath(path: string): Result<string, FileError> {
  if (CONTROL_CHARACTERS.test(path)) {
    return err(invalid("路径包含控制字符", path)); // i18n-ignore: model-facing
  }

  let relative = path;
  while (relative.startsWith("./")) relative = relative.slice(2);
  while (relative.startsWith("/")) relative = relative.slice(1);

  if (relative === "") {
    return err(invalid("路径为空", path)); // i18n-ignore: model-facing
  }

  const segments = relative.split("/");
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      CONTROL_CHARACTERS.test(segment)
    ) {
      return err(invalid("路径不合法", path)); // i18n-ignore: model-facing
    }
  }

  // Artifacts and attachments live outside the draft area; the read tool has
  // get_artifact for those keys.
  const first = segments[0]!;
  if (first === "inbox" || (ARTIFACT_TASK_SEGMENT.test(first) && segments.length >= 3)) {
    return err(
      invalid(
        "这是产物或附件的 key，请用 get_artifact 读取", // i18n-ignore: model-facing
        path,
      ),
    );
  }

  return ok(`/${segments.join("/")}`);
}

function keyFor(taskId: string, virtualPath: string): string {
  return workspacePrefix(taskId) + virtualPath.slice(1);
}

function fileInfoOf(object: R2Object, virtualPath: string): FileInfo {
  return {
    name: virtualPath.slice(virtualPath.lastIndexOf("/") + 1),
    path: virtualPath,
    kind: "file",
    size: object.size,
    mtimeMs: object.uploaded.getTime(),
  };
}

function notFound(path: string): FileError {
  return new FileError("not_found", "文件不存在", path); // i18n-ignore: model-facing
}

function unknown(path: string, error: unknown): FileError {
  const cause = error instanceof Error ? error : undefined;
  return new FileError(
    "unknown",
    cause?.message ?? String(error),
    path,
    cause,
  );
}

function notSupported(path?: string): FileError {
  return new FileError("not_supported", "草稿工作区不支持该操作", path); // i18n-ignore: model-facing
}

function tempNotSaved(): FileError {
  return new FileError(
    "not_supported",
    "草稿区不提供临时文件，完整输出未保存", // i18n-ignore: model-facing
  );
}

/**
 * A task's draft area in R2. The environment's root is `/`, mapped to
 * `work/<taskId>/`; artifacts and attachments stay readable only through
 * get_artifact, and nothing here can run a shell.
 */
export function createR2WorkspaceEnv(bucket: R2Bucket, taskId: string): ExecutionEnv {
  const resolve = (path: string) => normalizePath(path);

  return {
    id: `r2:work:${taskId}`,
    cwd: "/",

    async absolutePath(path, _context) {
      return resolve(path);
    },

    async joinPath(parts, context) {
      void context;
      return err(notSupported(parts.join("/")));
    },

    async readTextFile(path, context) {
      void context;
      const resolved = resolve(path);
      if (!resolved.ok) return resolved;
      const key = keyFor(taskId, resolved.value);
      try {
        const object = await bucket.get(key);
        if (object === null) return err(notFound(resolved.value));
        return ok(await object.text());
      } catch (error) {
        return err(unknown(resolved.value, error));
      }
    },

    async openTextLineReader(path, context) {
      void context;
      return err(notSupported(path));
    },

    async readTextLines(path, options, context) {
      void options;
      void context;
      return err(notSupported(path));
    },

    async readBinaryFile(path, context) {
      void context;
      return err(notSupported(path));
    },

    async openBinaryReader(path, options, context) {
      void options;
      void context;
      const resolved = resolve(path);
      if (!resolved.ok) return err(resolved.error);

      const virtualPath = resolved.value;
      const key = keyFor(taskId, virtualPath);
      let opened: R2Object | null;
      try {
        opened = await bucket.head(key);
      } catch (error) {
        return err(unknown(virtualPath, error));
      }
      if (opened === null) return err(notFound(virtualPath));

      const info = fileInfoOf(opened, virtualPath);
      const reader: BinaryReader = {
        async info(context) {
          void context;
          return ok(info);
        },

        async read(offset, length, context) {
          void context;
          if (length <= 0 || offset >= info.size) return ok(new Uint8Array(0));
          const start = Math.max(0, offset);
          const count = Math.min(length, info.size - start);
          if (count <= 0) return ok(new Uint8Array(0));
          try {
            const object = await bucket.get(key, {
              range: { offset: start, length: count },
            });
            if (object === null) return ok(new Uint8Array(0));
            return ok(new Uint8Array(await object.arrayBuffer()));
          } catch (error) {
            return err(unknown(virtualPath, error));
          }
        },

        async scanLines(options, context) {
          const { startLine, endLine } = options;
          void context;
          let scanner: LineScanner;
          try {
            scanner = new LineScanner(startLine, endLine);
          } catch {
            return err(invalid("行范围不合法", virtualPath)); // i18n-ignore: model-facing
          }
          try {
            const object = await bucket.get(key);
            if (object === null) return err(notFound(virtualPath));
            if (object.body !== null) {
              const stream = object.body.getReader();
              try {
                for (;;) {
                  const { done, value } = await stream.read();
                  if (done) break;
                  scanner.push(value);
                }
              } finally {
                stream.releaseLock();
              }
            }
            return ok(scanner.finish());
          } catch (error) {
            return err(unknown(virtualPath, error));
          }
        },

        async close(context) {
          void context;
        },
      };

      return ok(reader);
    },

    async writeFile(path, content, context) {
      void context;
      const resolved = resolve(path);
      if (!resolved.ok) return err(resolved.error);

      const isText = typeof content === "string";
      const bytes = isText ? new TextEncoder().encode(content) : content;
      if (bytes.byteLength > MAX_DRAFT_BYTES) {
        return err(invalid("草稿超过 1 MB", resolved.value)); // i18n-ignore: model-facing
      }

      try {
        await bucket.put(keyFor(taskId, resolved.value), bytes, {
          httpMetadata: {
            contentType:
              isText ? "text/plain; charset=utf-8" : "application/octet-stream",
          },
        });
        return ok(undefined);
      } catch (error) {
        return err(unknown(resolved.value, error));
      }
    },

    async appendFile(path, content, context) {
      void content;
      void context;
      return err(notSupported(path));
    },

    async truncateFile(path, size, context) {
      void size;
      void context;
      return err(notSupported(path));
    },

    async flushFile(path, context) {
      void context;
      return err(notSupported(path));
    },

    async renameFile(sourcePath, destinationPath, context) {
      void destinationPath;
      void context;
      return err(notSupported(sourcePath));
    },

    async fileInfo(path, context) {
      void context;
      const resolved = resolve(path);
      if (!resolved.ok) return err(resolved.error);
      try {
        const object = await bucket.head(keyFor(taskId, resolved.value));
        if (object === null) return err(notFound(resolved.value));
        return ok(fileInfoOf(object, resolved.value));
      } catch (error) {
        return err(unknown(resolved.value, error));
      }
    },

    async listDir(path, context) {
      void context;
      return err(notSupported(path));
    },

    async openDirReader(path, context) {
      void context;
      return err(notSupported(path));
    },

    async watch(targets, onChange, context) {
      void targets;
      void onChange;
      void context;
      return err(notSupported());
    },

    async canonicalPath(path, context) {
      void context;
      return err(notSupported(path));
    },

    async exists(path, context) {
      void context;
      const resolved = resolve(path);
      if (!resolved.ok) return err(resolved.error);
      try {
        const object = await bucket.head(keyFor(taskId, resolved.value));
        return ok(object !== null);
      } catch (error) {
        return err(unknown(resolved.value, error));
      }
    },

    async createDir(path, options, context) {
      void options;
      void context;
      return err(notSupported(path));
    },

    async remove(path, options, context) {
      void options;
      void context;
      return err(notSupported(path));
    },

    async createTempDir(prefix, context) {
      void prefix;
      void context;
      return err(tempNotSaved());
    },

    async createTempFile(options, context) {
      void options;
      void context;
      return err(tempNotSaved());
    },

    async cleanup(context) {
      void context;
    },

    async exec(command, options, context) {
      void command;
      void options;
      void context;
      return err(new ExecutionError("shell_unavailable", "草稿工作区不提供 shell")); // i18n-ignore: model-facing
    },
  };
}
