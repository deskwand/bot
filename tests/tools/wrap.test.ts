import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import type {
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { TaskEventBody } from "../../src/protocol";
import { withProgress } from "../../src/tools/wrap";

const Echo = Type.Object({ value: Type.String() });

function context(): Context {
  return { abortSignal: undefined } as unknown as Context;
}

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

function echoTool(
  execute: ToolRegistration<typeof Echo>["execute"],
): ToolRegistration<typeof Echo> {
  return {
    name: "echo",
    description: "Echo the value.",
    parameters: Echo,
    execute,
  };
}

describe("withProgress", () => {
  it("emits progress with the described args before executing", async () => {
    const events: TaskEventBody[] = [];
    const order: string[] = [];
    const tool = withProgress(
      echoTool(async ({ value }) => {
        order.push("execute");
        return { output: [{ type: "text", text: value }] };
      }),
      async (event) => {
        order.push("emit");
        events.push(event);
      },
      (args) => `回显：${args.value}`,
    );

    const result = await tool.execute(
      { value: "hi" },
      {} as never,
      context(),
    );

    expect(events).toEqual([{ type: "progress", text: "回显：hi" }]);
    expect(order).toEqual(["emit", "execute"]);
    expect(textOf(result)).toBe("hi");
  });

  it("turns a thrown tool error into an error output instead of failing the run", async () => {
    const events: TaskEventBody[] = [];
    const tool = withProgress(
      echoTool(async () => {
        throw new Error("boom");
      }),
      async (event) => {
        events.push(event);
      },
      (args) => `回显：${args.value}`,
    );

    const result = await tool.execute(
      { value: "x" },
      {} as never,
      context(),
    );

    expect(events).toHaveLength(1);
    expect(textOf(result)).toBe("工具出错：boom");
  });

  it("preserves a tool's replay policy", () => {
    const tool = withProgress(
      { ...echoTool(async () => ({ output: [] })), replay: "safe" },
      async () => {},
      () => "x",
    );

    expect(tool.replay).toBe("safe");
  });
});
