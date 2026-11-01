import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { TaskEventBody } from "../protocol";

/**
 * Emit a `progress` event before every tool call and turn thrown errors into
 * a tool result, so a failing tool cannot fail the whole task run.
 */
export function withProgress<T extends TSchema>(
  tool: ToolRegistration<T>,
  emit: (body: TaskEventBody) => Promise<void>,
  describe: (args: Static<T>) => string,
): ToolRegistration<T> {
  return {
    ...tool,
    async execute(args, api, context) {
      try {
        await emit({ type: "progress", text: describe(args) });
        return await tool.execute(args, api, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          output: [{ type: "text", text: `工具出错：${message}` }],
        };
      }
    },
  };
}
