import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

afterEach(() => {
  vi.restoreAllMocks();
});

function butler() {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

describe("TaskDO outbox retry", () => {
  it("schedules one retry after a failed flush and delivers when it fires", async () => {
    const taskId = `t-outbox-retry-${crypto.randomUUID()}`;
    const stub = env.TASK.get(env.TASK.idFromName(taskId));

    const first = await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as {
        setMeta(key: string, value: string): void;
        emitProgress(body: { type: "progress"; text: string }): Promise<void>;
        retryOutbox(): Promise<void>;
        deliver(event: unknown): Promise<void>;
        listSchedules(): Promise<{ callback: string }[]>;
      };
      target.setMeta("task_id", taskId);
      target.setMeta("title", "重试测试");

      const original = target.deliver.bind(instance);
      target.deliver = async () => {
        throw new Error("butler down");
      };

      await target.emitProgress({ type: "progress", text: "hello" });
      // A second failed flush must not enqueue a duplicate retry.
      await target.emitProgress({ type: "progress", text: "again" });

      const retries = (await target.listSchedules()).filter(
        (schedule) => schedule.callback === "retryOutbox",
      ).length;
      const eventsBeforeRetry = await butler().debugEvents(taskId);

      // The Butler was down for both attempts; restore it and run the retry
      // callback the schedule would invoke.
      target.deliver = original;
      await target.retryOutbox();

      return { retries, eventsBeforeRetry };
    });

    expect(first.retries).toBe(1);
    expect(first.eventsBeforeRetry).toEqual([]);

    const events = await butler().debugEvents(taskId);
    expect(events.map((event) => event.type)).toEqual([
      "progress",
      "progress",
    ]);
    expect(events.map((event) => event.payload)).toMatchObject([
      { text: "hello" },
      { text: "again" },
    ]);
  });
});
