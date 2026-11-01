import { PiHarness } from "agents/harness/pi";
import { Type } from "@earendil-works/pi-ai";
import type { ReportInfo, ToolRegistration } from "@earendil-works/pi-durable";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setModelOverride } from "../../src/llm/models";
import type { TaskSpec } from "../../src/protocol";
import { scriptedModel } from "../helpers/scripted-model";

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

afterEach(() => {
  setModelOverride(null);
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

  it("parks a task that keeps crashing and retries it", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "slow_wait", args: {} }] },
        { text: "after retry" },
      ]),
    );
    const taskId = "t-park";
    const stub = taskStub(taskId);
    await installSlowWait(stub);

    await stub.start(spec(taskId));
    await waitForSlowStart(stub);
    await reportParked(stub);

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events[1]?.payload).toMatchObject({
          type: "failed",
          reason: "任务反复中断，已暂停",
          retryable: true,
        });
      },
      { timeout: 10_000 },
    );
    expect((await stub.status()).state).toBe("failed");

    const result = await stub.retry();
    expect(result.ok).toBe(true);

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "failed",
          "started",
        ]);
      },
      { timeout: 10_000 },
    );
    expect((await stub.status()).state).toBe("running");

    await releaseSlowTask(stub);
    await vi.waitFor(
      async () => {
        expect((await stub.status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );
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

    const result = await stub.retry();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不可重试");
  });
});

/** Calls the DO's private report handler, as pi's `onReport` would. */
async function reportParked(stub: TaskStub): Promise<void> {
  const info = {
    type: "task_parked",
    task: { id: "pi-task", kind: "agent", conversationId: "1" },
  } as unknown as ReportInfo;
  await runInDurableObject(stub, async (instance) => {
    const sink = instance as unknown as {
      handleReport(error: unknown, info: ReportInfo): Promise<void>;
    };
    await sink.handleReport(undefined, info);
  });
}
