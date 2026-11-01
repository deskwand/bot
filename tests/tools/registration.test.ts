import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setModelOverride } from "../../src/llm/models";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

afterEach(() => {
  setModelOverride(null);
});

function butler() {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

describe("TaskDO execution tools", () => {
  it("installs web_search, web_fetch and save_artifact", async () => {
    const stub = env.TASK.get(env.TASK.idFromName("t-tools-registry"));

    const names = await runInDurableObject(stub, (instance) =>
      instance.registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name),
    );

    expect(names).toEqual(
      expect.arrayContaining([
        "finish_task",
        "web_search",
        "web_fetch",
        "save_artifact",
      ]),
    );
  });

  it("emits progress when a task calls save_artifact", async () => {
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "save_artifact",
              args: { filename: "report.md", content: "# body" },
            },
          ],
        },
        { toolCalls: [{ name: "finish_task", args: { summary: "saved" } }] },
      ]),
    );
    const taskId = "t-tool-progress";
    const stub = env.TASK.get(env.TASK.idFromName(taskId));

    await stub.start({
      taskId,
      title: "Tool progress",
      instructions: "save a report",
    });

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "progress",
          "completed",
        ]);
        expect(events[1]?.payload).toMatchObject({
          type: "progress",
          text: "保存：report.md",
        });
      },
      { timeout: 10_000 },
    );
  });
});
