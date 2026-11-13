import { Type, type TSchema } from "typebox";
import type {
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { MAX_ARTIFACT_BYTES, artifactKeySegments } from "../artifact";
import type { ArtifactStore } from "../artifact-store";
import { t, type Locale } from "../i18n";
import type { TaskEventBody } from "../protocol";
import { writeArtifact } from "../tools/artifacts";
import { withProgress } from "../tools/wrap";
import { workspacePrefix } from "../env/r2-env";
import { sandboxPathFromDraft } from "./paths";
import { SandboxError, type SandboxProvider } from "./types";

const DEFAULT_TIMEOUT_MS = 600_000;
const PUT_CAP_BYTES = 32 * 1024 * 1024;

const Run = Type.Object({
  command: Type.String({ description: "Shell command, run with /bin/sh -c." }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory inside the sandbox; defaults to /sandbox.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        "How long to wait before returning. The process keeps running after this. Defaults to 10 minutes.",
    }),
  ),
});

const Put = Type.Object({
  source: Type.String({
    description:
      "Artifact key (from save_artifact/get_artifact), or a draft path starting with /.",
  }),
  to: Type.String({ description: "Absolute path inside the sandbox." }),
});

const Get = Type.Object({
  path: Type.String({ description: "Absolute path inside the sandbox." }),
  filename: Type.Optional(Type.String()),
  contentType: Type.Optional(Type.String()),
});

export type SandboxToolDeps = {
  bucket: ArtifactStore;
  taskId: () => string;
  locale: () => Locale;
  timeoutMs?: number;
  /** Owner-visible progress lines; absent in unit tests and chat-free runs. */
  progress?: (body: TaskEventBody) => Promise<void>;
  /** Maintenance lease check, awaited before an artifact write. */
  guard?: () => Promise<void>;
};

function text(body: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text: body }], isError };
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeError(error: unknown): string {
  if (error instanceof SandboxError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Model-facing rendering of one exec result. */
function renderRun(
  command: string,
  result: Awaited<ReturnType<SandboxProvider["run"]>>,
): string {
  const usedPercent =
    result.disk.limitBytes > 0
      ? ((result.disk.usedBytes / result.disk.limitBytes) * 100).toFixed(1)
      : "?";
  const lines = [
    `exit ${String(result.exitCode)} · ${(result.durationMs / 1000).toFixed(1)}s · disk ${usedPercent}% of ${megabytes(result.disk.limitBytes)}`,
  ];
  if (result.error !== null) {
    lines.push(`could not start: ${result.error}`);
  }
  if (result.timedOut) {
    lines.push(
      `STILL RUNNING (pid ${String(result.pid)}) — the call timed out, the process was not killed, and its output is no longer captured. Check it with ps/tail; next time redirect to /sandbox/*.log.`,
    );
  }
  if (result.stdout !== "") {
    lines.push("stdout:", result.stdout);
    if (result.stdoutTruncated) {
      lines.push(
        "[stdout truncated at the 64 KB cap; the full output is on the machine]",
      );
    }
  }
  if (result.stderr !== "") {
    lines.push("stderr:", result.stderr);
    if (result.stderrTruncated) {
      lines.push(
        "[stderr truncated at the 64 KB cap; the full output is on the machine]",
      );
    }
  }
  if (result.stdout === "" && result.stderr === "" && !result.timedOut) {
    lines.push("(no output)");
  }
  lines.push(`command: ${command}`);
  return lines.join("\n");
}

/** Progress lines are owner-visible, so they go through i18n. */
export function sandboxProgressText(
  tool: string,
  args: Record<string, unknown>,
  locale: Locale,
): string {
  if (tool === "sandbox_run" && typeof args.command === "string") {
    return t(locale, "task.progress.sandboxRun", {
      command:
        args.command.length > 60 ? `${args.command.slice(0, 60)}…` : args.command,
    });
  }
  if (tool === "sandbox_put" && typeof args.source === "string") {
    return t(locale, "task.progress.sandboxPut", { source: args.source });
  }
  if (tool === "sandbox_get" && typeof args.path === "string") {
    return t(locale, "task.progress.sandboxGet", { path: args.path });
  }
  return tool;
}

export function createSandboxTools(
  provider: SandboxProvider,
  deps: SandboxToolDeps,
): ToolRegistration[] {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Same shape as the mail/exchange extensions: progress is optional, and each
  // wrapper keeps its own argument type instead of widening it to `object`.
  const wrap = <T extends TSchema>(
    tool: ToolRegistration<T>,
  ): ToolRegistration<T> => {
    const progress = deps.progress;
    if (progress === undefined) return tool;
    return withProgress(tool, progress, (args) =>
      sandboxProgressText(
        tool.name,
        args as Record<string, unknown>,
        deps.locale(),
      ),
    );
  };

  const run: ToolRegistration<typeof Run> = {
    name: "sandbox_run",
    description:
      "Run a shell command on your Linux sandbox (any command, root inside a throwaway container; /sandbox persists between tasks). Returns the exit code, capped stdout/stderr, the pid when it timed out, and disk usage. Long jobs must redirect their own output.",
    parameters: Run,
    async execute({ command, cwd, timeoutMs: explicit }, _api, context) {
      try {
        const result = await provider.run(command, {
          cwd,
          timeoutMs: explicit ?? timeoutMs,
          signal: context.abortSignal,
        });
        return text(renderRun(command, result));
      } catch (error) {
        return text(`sandbox_run failed — ${describeError(error)}`, true);
      }
    },
  };

  const put: ToolRegistration<typeof Put> = {
    name: "sandbox_put",
    description:
      "Copy an artifact (by key) or a draft file (by /path) into the sandbox. Up to 32 MB per call.",
    parameters: Put,
    async execute({ source, to }) {
      const taskId = deps.taskId();
      if (taskId === "") return text("task has not started", true);
      try {
        const key = source.startsWith("/")
          ? sandboxPathFromDraft(taskId, source)
          : source;
        // The bucket is shared: a bare key could name another task's draft or
        // artifact. Same rule as get_artifact.
        const scoped = source.startsWith("/")
          ? key.startsWith(workspacePrefix(taskId))
          : artifactKeySegments(key)?.[0] === taskId;
        if (!scoped) {
          return text(
            `not allowed to read ${source}: it does not belong to this task`,
            true,
          );
        }
        const object = await deps.bucket.get(key);
        if (object === null) return text(`not found: ${source}`, true);
        if (object.size > PUT_CAP_BYTES) {
          return text(
            `file is ${megabytes(object.size)}, the cap is ${megabytes(PUT_CAP_BYTES)}`,
            true,
          );
        }
        const data = new Uint8Array(await object.arrayBuffer());
        await provider.writeFile(to, data);
        return text(`copied ${source} → ${to} (${megabytes(data.byteLength)})`);
      } catch (error) {
        return text(`sandbox_put failed — ${describeError(error)}`, true);
      }
    },
  };

  const get: ToolRegistration<typeof Get> = {
    name: "sandbox_get",
    description:
      "Copy a file out of the sandbox and save it as an artifact the owner can receive (up to 15 MB). Returns the artifact key for get_artifact and finish_task.",
    parameters: Get,
    async execute({ path, filename, contentType }) {
      const taskId = deps.taskId();
      if (taskId === "") return text("task has not started", true);
      try {
        const data = await provider.readFile(path, MAX_ARTIFACT_BYTES);
        const name = filename ?? path.slice(path.lastIndexOf("/") + 1);
        // Same fence as save_artifact: a backup/restore must not miss this file.
        if (deps.guard) await deps.guard();
        const key = await writeArtifact(
          deps.bucket,
          taskId,
          data,
          name,
          contentType ?? "application/octet-stream",
        );
        return text(`saved as artifact ${key} (${megabytes(data.byteLength)})`);
      } catch (error) {
        return text(`sandbox_get failed — ${describeError(error)}`, true);
      }
    },
  };

  return [wrap(run), wrap(put), wrap(get)];
}
