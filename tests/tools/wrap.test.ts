import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import type {
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import type { TaskEventBody } from "../../src/protocol";
import { withProgress } from "../../src/tools/wrap";

const Echo = Type.Object({ value: Type.String() });

function context(signal?: AbortSignal): Context {
  return { abortSignal: signal } as unknown as Context;
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

  it("rethrows a tool error when the caller aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = withProgress(
      echoTool(async () => {
        throw new Error("mid-flight failure");
      }),
      async () => {},
      () => "x",
    );

    await expect(
      tool.execute({ value: "x" }, {} as never, context(controller.signal)),
    ).rejects.toThrow("mid-flight failure");
  });

  it("rethrows AbortError even without an aborted signal", async () => {
    const tool = withProgress(
      echoTool(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
      async () => {},
      () => "x",
    );

    await expect(
      tool.execute({ value: "x" }, {} as never, context()),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("still runs the tool when the progress emit fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let executed = 0;
    const tool = withProgress(
      echoTool(async ({ value }) => {
        executed += 1;
        return { output: [{ type: "text", text: value }] };
      }),
      async () => {
        throw new Error("outbox down");
      },
      () => "x",
    );

    try {
      const result = await tool.execute(
        { value: "tool output" },
        {} as never,
        context(),
      );

      expect(executed).toBe(1);
      expect(textOf(result)).toBe("tool output");
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
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
