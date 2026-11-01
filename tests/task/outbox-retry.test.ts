import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { fakeChannel } from "../helpers/fake-channel";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

beforeEach(() => {
  setChannelOverride("telegram", fakeChannel().adapter);
});

afterEach(() => {
  setChannelOverride("telegram", null);
  vi.useRealTimers();
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
        listSchedules(): Promise<{ id: string; callback: string }[]>;
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

      // Do not leave the test's retry alarm behind for later tests.
      const schedules = await target.listSchedules();
      const cancel = (
        instance as unknown as { cancelSchedule(id: string): Promise<boolean> }
      ).cancelSchedule.bind(instance);
      for (const schedule of schedules) await cancel(schedule.id);

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

  it("keeps rescheduling through the alarm until delivery succeeds", async () => {
    // Only Date is faked: the alarm still runs with real platform timers, and
    // advancing the clock makes each retry due exactly as it would in
    // production.
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2030-01-01T00:00:00Z");
    vi.setSystemTime(start);

    const taskId = `t-outbox-chain-${crypto.randomUUID()}`;
    const stub = env.TASK.get(env.TASK.idFromName(taskId));

    const probe = () =>
      runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          readMeta(key: string): string | undefined;
          listSchedules(): Promise<
            { id: string; callback: string; time: number }[]
          >;
        };
        const retries = (await target.listSchedules())
          .filter((schedule) => schedule.callback === "retryOutbox")
          .map(({ id, time }) => ({ id, time }));
        return {
          retries,
          attempt: Number(target.readMeta("outbox_retry_attempt") ?? "0"),
        };
      });

    try {
      await runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          setMeta(key: string, value: string): void;
          emitProgress(body: { type: "progress"; text: string }): Promise<void>;
          deliver(event: unknown): Promise<void>;
        };
        target.setMeta("task_id", taskId);
        target.setMeta("title", "重试链测试");

        // The Butler stays down for the emit and for both delivery attempts
        // inside the first alarm: the scheduled retry, then the host flush
        // that runs after due jobs. It recovers before the second alarm.
        let failures = 3;
        const original = target.deliver.bind(instance);
        target.deliver = async (event) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error("butler down");
          }
          await original(event);
        };

        await target.emitProgress({ type: "progress", text: "survives" });
      });

      // First failure: one retry is pending after 30 seconds.
      const afterEmit = await probe();
      expect(afterEmit.retries).toHaveLength(1);
      expect(afterEmit.attempt).toBe(1);
      expect(afterEmit.retries[0].time * 1000 - Date.now()).toBe(30_000);
      expect(await butler().debugEvents(taskId)).toEqual([]);

      // The retry itself fails. It must schedule its successor before the
      // lifecycle deletes the job row it is currently running.
      vi.setSystemTime(start.getTime() + 31_000);
      expect(await runDurableObjectAlarm(stub)).toBe(true);

      const afterFirstAlarm = await probe();
      expect(afterFirstAlarm.retries).toHaveLength(1);
      expect(afterFirstAlarm.retries[0].id).not.toBe(
        afterEmit.retries[0].id,
      );
      expect(afterFirstAlarm.attempt).toBe(2);
      expect(afterFirstAlarm.retries[0].time * 1000 - Date.now()).toBe(60_000);
      expect(await butler().debugEvents(taskId)).toEqual([]);

      // The second retry succeeds: the event lands, the attempt resets and no
      // retry remains scheduled.
      vi.setSystemTime(start.getTime() + 92_000);
      expect(await runDurableObjectAlarm(stub)).toBe(true);

      const afterSecondAlarm = await probe();
      expect(afterSecondAlarm.retries).toEqual([]);
      expect(afterSecondAlarm.attempt).toBe(0);
      const events = await butler().debugEvents(taskId);
      expect(events.map((event) => event.payload)).toMatchObject([
        { text: "survives" },
      ]);
    } finally {
      // Do not leave the test's retry alarm behind for later tests.
      await runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          listSchedules(): Promise<{ id: string }[]>;
          cancelSchedule(id: string): Promise<boolean>;
        };
        for (const schedule of await target.listSchedules()) {
          await target.cancelSchedule(schedule.id);
        }
      });
    }
  });
});
