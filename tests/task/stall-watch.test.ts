import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import type { TaskEvent, TaskEventBody, TaskSpec } from "../../src/protocol";
import type { TaskState } from "../../src/task/task-do";
import { STALL_AFTER_MS } from "../../src/task/stall";
import { fakeChannel } from "../helpers/fake-channel";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

type ScheduleInfo = { id: string; callback: string; time: number };

/**
 * The private TaskDO surface the stall watch tests drive directly, plus the
 * test-only event sink that replaces delivery to the Butler.
 */
type StallInternals = {
  setMeta(key: string, value: string): void;
  spec: TaskSpec | null;
  deliver(event: TaskEvent): Promise<void>;
  listSchedules(): Promise<ScheduleInfo[]>;
  cancelSchedule(id: string): Promise<boolean>;
  onToolStart(call: { id: string; name: string }): void;
  onToolEnd(call: { id: string }): void;
  onModelResponse(): void;
  beginStallWatch(): Promise<void>;
  checkStall(payload?: unknown, schedule?: unknown): Promise<void>;
  emitProgress(body: TaskEventBody): Promise<void>;
  __delivered?: TaskEvent[];
};

function taskStub() {
  const taskId = `t-stall-${crypto.randomUUID()}`;
  return { taskId, stub: env.TASK.get(env.TASK.idFromName(taskId)) };
}

async function prepareTask(
  stub: ReturnType<typeof taskStub>["stub"],
  taskId: string,
  options: { botId?: string; state?: TaskState } = {},
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as StallInternals;
    target.setMeta("task_id", taskId);
    target.setMeta("title", "卡住测试");
    target.setMeta("state", options.state ?? "running");
    target.spec = {
      taskId,
      title: "卡住测试",
      instructions: "go",
      ...(options.botId === undefined ? {} : { botId: options.botId }),
    };
    target.__delivered = [];
    target.deliver = async (event) => {
      target.__delivered!.push(event);
    };
  });
}

async function delivered(
  stub: ReturnType<typeof taskStub>["stub"],
): Promise<TaskEvent[]> {
  return runInDurableObject(stub, (instance) =>
    ((instance as unknown as StallInternals).__delivered ?? []).map((event) => ({
      ...event,
    })),
  );
}

async function stalled(
  stub: ReturnType<typeof taskStub>["stub"],
): Promise<TaskEvent[]> {
  return (await delivered(stub)).filter((event) => event.type === "stalled");
}

async function pendingStallChecks(
  stub: ReturnType<typeof taskStub>["stub"],
): Promise<ScheduleInfo[]> {
  return runInDurableObject(stub, async (instance) => {
    const target = instance as unknown as StallInternals;
    const now = Date.now();
    return (await target.listSchedules()).filter(
      (schedule) =>
        schedule.callback === "checkStall" && schedule.time * 1000 > now,
    );
  });
}

async function cancelSchedules(
  stub: ReturnType<typeof taskStub>["stub"],
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    const target = instance as unknown as StallInternals;
    for (const schedule of await target.listSchedules()) {
      await target.cancelSchedule(schedule.id);
    }
  });
}

beforeEach(() => {
  setChannelOverride("telegram", fakeChannel().adapter);
});

afterEach(() => {
  setChannelOverride("telegram", null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TaskDO stall watch", () => {
  it("emits one stalled event when a tool never returns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2030-01-01T00:00:00Z");
    vi.setSystemTime(start);
    const { taskId, stub } = taskStub();
    await prepareTask(stub, taskId);

    await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as StallInternals;
      await target.beginStallWatch();
      target.onToolStart({ id: "call-1", name: "web_fetch" });
    });

    vi.setSystemTime(start.getTime() + STALL_AFTER_MS);
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as StallInternals).checkStall();
    });

    expect(await stalled(stub)).toEqual([
      expect.objectContaining({
        type: "stalled",
        activity: { kind: "running_tool", tool: "web_fetch" },
        idleMs: STALL_AFTER_MS,
      }),
    ]);

    // A tool that legitimately runs longer than the threshold is only
    // reported once; every later check stays quiet (Review Focus 3).
    vi.setSystemTime(start.getTime() + STALL_AFTER_MS * 2);
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as StallInternals).checkStall();
    });
    expect(await stalled(stub)).toHaveLength(1);

    await cancelSchedules(stub);
  });

  it("reports waiting_model after a tool finished and nothing followed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2030-01-01T00:00:00Z");
    vi.setSystemTime(start);
    const { taskId, stub } = taskStub();
    await prepareTask(stub, taskId);

    await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as StallInternals;
      await target.beginStallWatch();
      target.onToolStart({ id: "call-1", name: "web_fetch" });
    });

    vi.setSystemTime(start.getTime() + 1_000);
    await runInDurableObject(stub, async (instance) => {
      (instance as unknown as StallInternals).onToolEnd({ id: "call-1" });
    });

    vi.setSystemTime(start.getTime() + 1_000 + STALL_AFTER_MS);
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as StallInternals).checkStall();
    });

    expect(await stalled(stub)).toEqual([
      expect.objectContaining({
        activity: { kind: "waiting_model" },
        idleMs: STALL_AFTER_MS,
      }),
    ]);

    await cancelSchedules(stub);
  });

  it("names the tool still running when a parallel one finishes first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2030-01-01T00:00:00Z");
    vi.setSystemTime(start);
    const { taskId, stub } = taskStub();
    await prepareTask(stub, taskId);

    await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as StallInternals;
      await target.beginStallWatch();
      target.onToolStart({ id: "a", name: "web_fetch" });
      target.onToolStart({ id: "b", name: "http_request" });
      target.onToolEnd({ id: "b" });
    });

    vi.setSystemTime(start.getTime() + STALL_AFTER_MS);
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as StallInternals).checkStall();
    });

    expect(await stalled(stub)).toEqual([
      expect.objectContaining({
        activity: { kind: "running_tool", tool: "web_fetch" },
      }),
    ]);

    await cancelSchedules(stub);
  });

  it("emits nothing once the task is no longer running", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2030-01-01T00:00:00Z");
    vi.setSystemTime(start);
    const { taskId, stub } = taskStub();
    await prepareTask(stub, taskId);

    await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as StallInternals;
      await target.beginStallWatch();
      target.onToolStart({ id: "call-1", name: "web_fetch" });
      // The run finished just before the scheduled check fired.
      target.setMeta("state", "completed");
    });

    vi.setSystemTime(start.getTime() + STALL_AFTER_MS);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await stalled(stub)).toEqual([]);
    expect(await pendingStallChecks(stub)).toEqual([]);
  });

  it("never watches a bot run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2030-01-01T00:00:00Z");
    vi.setSystemTime(start);
    const { taskId, stub } = taskStub();
    await prepareTask(stub, taskId, { botId: "bot-1" });

    await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as StallInternals;
      await target.beginStallWatch();
      target.onToolStart({ id: "call-1", name: "web_fetch" });
    });

    vi.setSystemTime(start.getTime() + STALL_AFTER_MS);
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as StallInternals).checkStall();
    });

    expect(await stalled(stub)).toEqual([]);

    await cancelSchedules(stub);
  });

  it("keeps one pending checkStall schedule and resumes after a restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2030-01-01T00:00:00Z");
    vi.setSystemTime(start);
    const { taskId, stub } = taskStub();
    await prepareTask(stub, taskId);

    await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as StallInternals;
      // A second begin (e.g. a retried start) must not add a second check.
      await target.beginStallWatch();
      await target.beginStallWatch();
      target.onToolStart({ id: "call-1", name: "web_fetch" });
    });

    const pending = await pendingStallChecks(stub);
    expect(pending).toHaveLength(1);
    expect(pending[0].time * 1000).toBe(start.getTime() + STALL_AFTER_MS);

    // The schedule lives in the object's storage: a later alarm on a fresh
    // wake still finds it due and delivers the stalled event.
    vi.setSystemTime(start.getTime() + STALL_AFTER_MS);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await stalled(stub)).toEqual([
      expect.objectContaining({
        activity: { kind: "running_tool", tool: "web_fetch" },
      }),
    ]);

    const resumed = await pendingStallChecks(stub);
    expect(resumed).toHaveLength(1);
    expect(resumed[0].time * 1000).toBe(start.getTime() + STALL_AFTER_MS * 2);

    await cancelSchedules(stub);
  });
});
