import { describe, expect, it } from "vitest";
import {
  CRON,
  ensureOnce,
  ensureTicker,
  nextMinute,
  runTick,
  type AlarmStorage,
  type ScheduledTarget,
  type TickerState,
} from "../../container/front/ticker";

type ScheduledCall = { scheduledTime: Date; cron: string };

function fakeTarget(): { calls: ScheduledCall[]; target: ScheduledTarget } {
  const calls: ScheduledCall[] = [];
  return {
    calls,
    target: {
      async scheduled(options) {
        calls.push(options);
      },
    },
  };
}

function fakeStorage(alarm: number | null): {
  alarms: number[];
  storage: AlarmStorage;
} {
  const alarms: number[] = [];
  return {
    alarms,
    storage: {
      async getAlarm() {
        return alarm;
      },
      async setAlarm(time) {
        alarms.push(time);
      },
    },
  };
}

describe("nextMinute", () => {
  it("rounds up to the next whole minute", () => {
    expect(nextMinute(Date.UTC(2026, 10, 13, 9, 5, 30))).toBe(
      Date.UTC(2026, 10, 13, 9, 6, 0),
    );
  });

  it("never returns the current instant", () => {
    const now = Date.UTC(2026, 10, 13, 9, 5, 0);
    expect(nextMinute(now)).toBe(now + 60_000);
  });
});

describe("runTick", () => {
  it("fires the scheduled handler once with the cron", async () => {
    const { calls, target } = fakeTarget();
    const { storage } = fakeStorage(null);
    const now = Date.UTC(2026, 10, 13, 9, 5, 30);

    await runTick(target, storage, now);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cron).toBe(CRON);
    expect(calls[0]!.cron).toBe("* * * * *");
    expect(calls[0]!.scheduledTime.getTime()).toBe(now);
  });

  it("schedules the next alarm", async () => {
    const { target } = fakeTarget();
    const { alarms, storage } = fakeStorage(null);
    const now = Date.UTC(2026, 10, 13, 9, 5, 30);

    await runTick(target, storage, now);

    expect(alarms).toEqual([nextMinute(now)]);
  });

  it("still schedules when the handler throws", async () => {
    const alarms: number[] = [];
    const target: ScheduledTarget = {
      async scheduled() {
        throw new Error("boom");
      },
    };
    const storage: AlarmStorage = {
      async getAlarm() {
        return null;
      },
      async setAlarm(time) {
        alarms.push(time);
      },
    };
    const now = Date.UTC(2026, 10, 13, 9, 5, 30);

    await expect(runTick(target, storage, now)).resolves.toBeUndefined();
    expect(alarms).toEqual([nextMinute(now)]);
  });
});

describe("ensureTicker", () => {
  it("sets an alarm when none is pending", async () => {
    const { alarms, storage } = fakeStorage(null);
    const now = Date.UTC(2026, 10, 13, 9, 5, 30);

    await ensureTicker(storage, now);

    expect(alarms).toEqual([nextMinute(now)]);
  });

  it("leaves a pending alarm alone", async () => {
    const { alarms, storage } = fakeStorage(Date.UTC(2026, 10, 13, 9, 6, 0));

    await ensureTicker(storage, Date.UTC(2026, 10, 13, 9, 5, 30));

    expect(alarms).toEqual([]);
  });
});

describe("ensureOnce", () => {
  it("runs ensure and remembers success", async () => {
    const state: TickerState = { ensured: false };
    let calls = 0;
    const ensure = async () => {
      calls += 1;
    };

    await ensureOnce(state, ensure);
    await ensureOnce(state, ensure);

    expect(calls).toBe(1);
    expect(state.ensured).toBe(true);
  });

  it("retries after a failed ensure", async () => {
    const state: TickerState = { ensured: false };
    let calls = 0;
    const ensure = async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    };

    await expect(ensureOnce(state, ensure)).rejects.toThrow();
    expect(state.ensured).toBe(false);

    await ensureOnce(state, ensure);
    expect(calls).toBe(2);
    expect(state.ensured).toBe(true);
  });
});
