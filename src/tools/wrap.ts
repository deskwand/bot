import type { TSchema } from "typebox";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { TaskEventBody } from "../protocol";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether `error` is an abort signal's error rather than a tool failure. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** The result a tool failure becomes: readable text and `isError`, never a throw. */
export function toolErrorResult(error: unknown): ToolExecutionResult {
  return {
    output: [{ type: "text", text: `工具出错：${errorMessage(error)}` }],
    isError: true,
  };
}

/**
 * Emit a `progress` event before every tool call and turn thrown errors into
 * a tool result, so a failing tool cannot fail the whole task run. Aborts are
 * rethrown: a cancelled run must not continue as if the tool had answered.
 */
export function withProgress<T extends TSchema>(
  tool: ToolRegistration<T>,
  emit: (body: TaskEventBody) => Promise<void>,
  describe: (args: Parameters<ToolRegistration<T>["execute"]>[0]) => string,
): ToolRegistration<T> {
  return {
    ...tool,
    async execute(args, api, context) {
      // Progress is best-effort: an outbox failure must not skip the tool.
      try {
        await emit({ type: "progress", text: describe(args) });
      } catch (error) {
        console.warn(
          `tool ${tool.name} progress emit failed: ${errorMessage(error)}`,
        );
      }

      let result;
      try {
        result = await tool.execute(args, api, context);
      } catch (error) {
        if (context.abortSignal?.aborted || isAbortError(error)) throw error;
        return toolErrorResult(error);
      }

      try {
        await emit({ type: "progress", text: `${describe(args)} ✓` });
      } catch (error) {
        console.warn(
          `tool ${tool.name} progress emit failed: ${errorMessage(error)}`,
        );
      }
      return result;
    },
  };
}
