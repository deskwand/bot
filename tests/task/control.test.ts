import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PiHarness } from "agents/harness/pi";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import type { TaskSpec } from "../../src/protocol";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";
import { mapSettledFailureToRestartLimit, operationIdOf, reportInterruption } from "../helpers/task-recovery";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const SlowWait = Type.Object({});

type TaskStub = ReturnType<typeof taskStub>;

/** State of the test-only slow tool, kept inside the task object. */
type SlowControl = { started: boolean; released: boolean };

function slowControl(instance: unknown): SlowControl | undefined {
  return (instance as { slowControl?: SlowControl }).slowControl;
}

function butler() {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

function taskStub(taskId: string) {
  return env.TASK.get(env.TASK.idFromName(taskId));
}

function spec(taskId: string, instructions = "do the thing"): TaskSpec {
  return { taskId, title: `Task ${taskId}`, instructions };
}

/**
 * Installs a tool that stays running until `releaseSlowTask`. The gate lives
 * in the task object: awaiting a promise created by the test would run the
 * tool's continuation in the test's I/O context, which workerd rejects.
 */
async function installSlowWait(stub: TaskStub): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const control: SlowControl = { started: false, released: false };
    (instance as { slowControl?: SlowControl }).slowControl = control;

    const tool: ToolRegistration<typeof SlowWait> = {
      name: "slow_wait",
      description: "Wait until the test releases the run.",
      parameters: SlowWait,
      async execute() {
        control.started = true;
        while (!control.released) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return { output: [{ type: "text", text: "released" }] };
      },
    };
    instance.registry.install({ name: "test-slow", tools: [tool] });
  });
}

async function waitForSlowStart(stub: TaskStub): Promise<void> {
  await vi.waitFor(
    async () => {
      const started = await runInDurableObject(
        stub,
        (instance) => slowControl(instance)?.started ?? false,
      );
      expect(started).toBe(true);
    },
    { timeout: 10_000 },
  );
}

async function releaseSlowTask(stub: TaskStub): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const control = slowControl(instance);
    if (control) control.released = true;
  });
}

beforeEach(() => {
  setChannelOverride("telegram", fakeChannel().adapter);
});

afterEach(() => {
  setModelOverride(null);
  setChannelOverride("telegram", null);
  vi.restoreAllMocks();
});

describe("TaskDO control", () => {
  it("steers a running task into the next model request", async () => {
    const requests: string[] = [];
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "slow_wait", args: {} }] },
        {
          text: "second turn",
          observe: (context) => requests.push(JSON.stringify(context.messages)),
        },
      ]),
    );
    const taskId = "t-steer";
    const stub = taskStub(taskId);
    await installSlowWait(stub);

    await stub.start(spec(taskId));
    await waitForSlowStart(stub);

    const result = await stub.steer("换方向");
    expect(result.ok).toBe(true);
    await releaseSlowTask(stub);

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
        expect(events[1]?.payload).toMatchObject({ summary: "second turn" });
      },
      { timeout: 10_000 },
    );

    // The steer joined the run: the next model request carried it.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("换方向");
  });

  it("refuses to steer a completed task", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
      ]),
    );
    const taskId = "t-steer-done";
    const stub = taskStub(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        expect((await stub.status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    const result = await stub.steer("too late");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("已完成");
  });

  it("continues a completed task in its own conversation", async () => {
    // The Butler's announcements share this script, so record every request
    // instead of relying on which step the follow-up lands on.
    const requests: string[] = [];
    const record = {
      observe: (context: { messages: unknown }) => {
        requests.push(JSON.stringify(context.messages));
      },
    };
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "first" } }] },
        ...Array.from({ length: 8 }, () => ({ text: "second", ...record })),
      ]),
    );
    const taskId = "t-continue";
    const stub = taskStub(taskId);

    await stub.start(spec(taskId, "写一份初稿"));
    await vi.waitFor(
      async () => {
        expect((await stub.status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    const result = await stub.continueTask("再补一段结论");
    expect(result.ok).toBe(true);

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
          "started",
          "completed",
        ]);
        expect(events[3]?.payload).toMatchObject({ summary: "second" });
      },
      { timeout: 10_000 },
    );
    expect((await stub.status()).state).toBe("completed");

    // The follow-up ran on the same transcript: the first round is still there.
    const followUp = requests.find((request) => request.includes("再补一段结论"));
    expect(followUp).toBeDefined();
    expect(followUp).toContain("写一份初稿");
    expect(followUp).toContain("first");
  }, 30_000);

  it("refuses to continue a task that has not completed", async () => {
    const stub = taskStub("t-continue-new");
    const result = await stub.continueTask("x");
    expect(result.ok).toBe(false);
  });

  it("cancels a running task once", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "slow_wait", args: {} }] },
        { text: "should not finish" },
      ]),
    );
    const taskId = "t-cancel";
    const stub = taskStub(taskId);
    await installSlowWait(stub);

    await stub.start(spec(taskId));
    await waitForSlowStart(stub);

    // `cancel()` waits for the run to abort; the blocked tool is released
    // once the cancelled event has been reported.
    const cancelling = stub.cancel();
    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toContain("cancelled");
      },
      { timeout: 5_000 },
    );
    await releaseSlowTask(stub);
    await expect(cancelling).resolves.toMatchObject({ ok: true });

    expect(await stub.status()).toMatchObject({ state: "cancelled" });

    const again = await stub.cancel();
    expect(again.ok).toBe(false);

    const events = await butler().debugEvents(taskId);
    expect(events.filter((event) => event.type === "cancelled")).toHaveLength(1);
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("retries a settled failure on a fresh operation id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const taskId = "t-retry-settled";
    const stub = taskStub(taskId);
    const recovery = scriptedModel([
      { toolCalls: [{ name: "slow_wait", args: {} }] },
      { text: "after retry" },
    ]);
    setModelOverride(scriptedModel([{ error: "synthetic run failure" }]));
    mapSettledFailureToRestartLimit(`task:${taskId}`);
    await installSlowWait(stub);
    await stub.start(spec(taskId));
    await vi.waitFor(async () => {
      expect((await stub.status()).state).toBe("failed");
      expect((await butler().debugEvents(taskId))[1]?.payload).toMatchObject({ retryable: true });
    });
    expect(await runInDurableObject(stub, (instance) => instance.harness.pending())).toEqual([]);

    await runInDurableObject(stub, (instance) => instance.harness.session().setModel(recovery));
    expect((await stub.retryTask()).ok).toBe(true);
    expect(await operationIdOf(stub)).toBe(`task:${taskId}:retry:1`);
    await waitForSlowStart(stub);
    expect((await butler().debugEvents(taskId)).map((event) => event.type))
      .toEqual(["started", "failed", "started"]);
    await releaseSlowTask(stub);
    const result = await runInDurableObject(stub, (instance) =>
      instance.harness.wait(`task:${taskId}:retry:1`),
    );
    expect(result.status).toBe("done");
    await vi.waitFor(async () => expect((await stub.status()).state).toBe("completed"));
  });

  it.each(["pi.tool", "pi.compaction"])("keeps a run alive after a %s interruption report", async (kind) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const taskId = `t-local-${kind}`;
    const stub = taskStub(taskId);
    setModelOverride(scriptedModel([
      { toolCalls: [{ name: "slow_wait", args: {} }] },
      { text: "finished despite local failure" },
    ]));
    await installSlowWait(stub);
    await stub.start(spec(taskId));
    await waitForSlowStart(stub);
    await reportInterruption(stub, kind);
    expect((await stub.status()).state).toBe("running");
    expect((await butler().debugEvents(taskId)).map((event) => event.type)).toEqual(["started"]);
    await releaseSlowTask(stub);
    await vi.waitFor(async () => expect((await stub.status()).state).toBe("completed"));
    expect((await butler().debugEvents(taskId)).map((event) => event.type))
      .toEqual(["started", "completed"]);
  });

  it("starts the session at the task role's default thinking level", async () => {
    setModelOverride(scriptedModel([{ text: "done" }]));
    const taskId = "t-thinking";
    const stub = taskStub(taskId);

    await stub.start(spec(taskId));

    // opencode-go/deepseek-v4.1-flash offers low, high, max.
    const level = await runInDurableObject(stub, async (instance) => {
      const conversation = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
      return (await conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel;
    });
    expect(level).toBe("high");
  });

  it("refuses to retry a failure that is not retryable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(PiHarness.prototype, "wait").mockRejectedValue(
      new Error("model exploded"),
    );
    setModelOverride(scriptedModel([{ text: "never read" }]));
    const taskId = "t-no-retry";
    const stub = taskStub(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "failed",
        ]);
      },
      { timeout: 10_000 },
    );

    const result = await stub.retryTask();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不可重试");
  });
});
