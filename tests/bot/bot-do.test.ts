import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFER_MS } from "../../src/admin/maintenance";
import {
  setBotButlerOverride,
  type BotButler,
  type BotInit,
  type SpawnForBotResult,
} from "../../src/bot/bot-do";
import {
  BotStore,
  type BotMeta,
  type RunOutcome,
} from "../../src/bot/bot-store";
import {
  CHANNEL_DISABLED_RETRY_MS,
  WATCHDOG_MS,
  nextUtcMidnight,
  utcDay,
} from "../../src/bot/wake";
import { setClockOverride } from "../../src/butler/notifier";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const START = Date.UTC(2030, 0, 1, 9, 0, 0);

let now = START;

type BotStub = ReturnType<typeof botStub>;

function botStub(name: string) {
  return env.BOT.get(env.BOT.idFromName(name));
}

type FakeState = {
  spawns: { botId: string; title: string; instructions: string }[];
  notices: { botId: string; text: string }[];
  spawnResult: (index: number) => SpawnForBotResult;
  outcome: { outcome: RunOutcome | null; summary: string };
  maintenance: boolean;
  maintenanceThrows: boolean;
};

/** A Butler stand-in that records calls and answers from mutable state. */
function fakeButler(): FakeState {
  const state: FakeState = {
    spawns: [],
    notices: [],
    spawnResult: (index) => ({ ok: true, taskId: `t${index}` }),
    outcome: { outcome: null, summary: "" },
    maintenance: false,
    maintenanceThrows: false,
  };

  const butler: BotButler = {
    async spawnForBot(botId, title, instructions) {
      state.spawns.push({ botId, title, instructions });
      return state.spawnResult(state.spawns.length);
    },
    async botTaskOutcome() {
      return state.outcome;
    },
    async botNotice(botId, text) {
      state.notices.push({ botId, text });
    },
    async maintenanceActive() {
      if (state.maintenanceThrows) throw new Error("butler down");
      return state.maintenance;
    },
  };

  setBotButlerOverride(butler);
  return state;
}

async function initBot(stub: BotStub, patch: Partial<BotInit> = {}) {
  await stub.init({
    botId: "b1",
    name: "价格哨兵",
    mission: "盯着价格",
    defaultIntervalMs: 86_400_000,
    firstWakeAt: now,
    ...patch,
  });
}

async function fireAlarm(stub: BotStub): Promise<void> {
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

async function alarmAt(stub: BotStub): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.getAlarm(),
  );
}

async function patchMeta(
  stub: BotStub,
  patch: Partial<BotMeta>,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const store = new BotStore(state.storage.sql);
    const meta = store.readMeta();
    if (meta !== null) store.writeMeta({ ...meta, ...patch });
  });
}

beforeEach(() => {
  now = START;
  setClockOverride({
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  setBotButlerOverride(null);
  setClockOverride(null);
});

describe("BotDO lifecycle", () => {
  it("first alarm spawns a run and arms the watchdog", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-first");
    await initBot(stub);

    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(1);
    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.currentTaskId).toBe("t1");
    expect(await alarmAt(stub)).toBe(now + WATCHDOG_MS);
  });

  it("alarm during a run does not spawn again", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-running");
    await initBot(stub);
    await fireAlarm(stub);

    now += WATCHDOG_MS;
    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(1);
    expect(await alarmAt(stub)).toBe(now + WATCHDOG_MS);
  });

  it("resume during a run re-checks it right away", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-resume-running");
    await initBot(stub);
    await fireAlarm(stub);
    await stub.pause();
    expect(await alarmAt(stub)).toBeNull();

    await stub.resume(false);
    expect(await alarmAt(stub)).toBe(now);

    fake.outcome = { outcome: "completed", summary: "看完了" };
    await fireAlarm(stub);
    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.currentTaskId).toBeNull();
    expect(fake.spawns).toHaveLength(1);
  });

  it("watchdog records a finished run", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-watchdog");
    await initBot(stub);
    await fireAlarm(stub);

    now += WATCHDOG_MS;
    fake.outcome = { outcome: "completed", summary: "看完了" };
    await fireAlarm(stub);

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.currentTaskId).toBeNull();
    expect(snapshot?.meta.nextWakeAt).toBe(now + snapshot!.meta.defaultIntervalMs);
    expect(snapshot?.runs).toHaveLength(1);
    expect(snapshot?.runs[0]).toMatchObject({
      taskId: "t1",
      outcome: "completed",
      summary: "看完了",
    });
    expect(await alarmAt(stub)).toBe(snapshot?.meta.nextWakeAt);
  });

  it("setNextWake is clamped", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-clamp");
    await initBot(stub);

    const result = await stub.setNextWake({ at: now - 1 });

    expect(result).toEqual({ at: now + 300_000, clamped: true });
    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.nextWakeAt).toBe(now + 300_000);
    expect(await alarmAt(stub)).toBe(now + 300_000);
  });

  it("onRunEnded is idempotent", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-idempotent");
    await initBot(stub);

    await stub.onRunEnded("t-fast", "failed", "boom");
    await stub.onRunEnded("t-fast", "failed", "boom");

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.consecutiveFailures).toBe(1);
    expect(snapshot?.runs).toHaveLength(1);
  });

  it("run that ends before spawn returns", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-fast-run");
    await initBot(stub);
    // The run reports back before `spawnForBot` returns, so its row is already
    // ended when the alarm tries to claim it.
    await stub.onRunEnded("t1", "completed", "抢跑");

    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(1);

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.currentTaskId).toBeNull();
    expect(snapshot?.runs).toHaveLength(1);
    expect(await alarmAt(stub)).toBe(now + snapshot!.meta.defaultIntervalMs);
  });

  it("failures back off then pause", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-backoff");
    await initBot(stub, { defaultIntervalMs: 300_000 });
    await fireAlarm(stub);

    now += WATCHDOG_MS;
    fake.outcome = { outcome: "failed", summary: "boom" };
    await fireAlarm(stub);
    expect(await alarmAt(stub)).toBe(now + 900_000);

    now += 900_000;
    await fireAlarm(stub);
    expect(fake.spawns).toHaveLength(2);
    now += WATCHDOG_MS;
    fake.outcome = { outcome: "failed", summary: "boom" };
    await fireAlarm(stub);
    expect(await alarmAt(stub)).toBe(now + 3_600_000);

    now += 3_600_000;
    await fireAlarm(stub);
    expect(fake.spawns).toHaveLength(3);
    now += WATCHDOG_MS;
    fake.outcome = { outcome: "failed", summary: "boom" };
    await fireAlarm(stub);

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.status).toBe("paused");
    expect(await alarmAt(stub)).toBeNull();
    expect(fake.notices).toEqual([
      {
        botId: "b1",
        text: "⚠️ 价格哨兵 已暂停：连续 3 次失败（最近原因：boom）",
      },
    ]);
  });

  it("success resets the failure count", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-success-reset");
    await initBot(stub);

    await stub.onRunEnded("t-fail-1", "failed", "boom");
    await stub.onRunEnded("t-fail-2", "failed", "boom");
    expect((await stub.snapshot())?.meta.consecutiveFailures).toBe(2);

    await stub.onRunEnded("t-ok", "completed", "好了");

    expect((await stub.snapshot())?.meta.consecutiveFailures).toBe(0);
  });

  it("cancelled does not count as a failure", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-cancelled");
    await initBot(stub);

    await stub.onRunEnded("t-fail", "failed", "boom");
    await stub.onRunEnded("t-cancel", "cancelled", "停掉了");

    expect((await stub.snapshot())?.meta.consecutiveFailures).toBe(1);
  });

  it("channel disabled skips without counting", async () => {
    const fake = fakeButler();
    fake.spawnResult = () => ({
      ok: false,
      reason: "channel_disabled",
      message: "没有渠道",
    });
    const stub = botStub("b-lifecycle-channel");
    await initBot(stub);

    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(1);
    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.wakesCount).toBe(0);
    expect(snapshot?.runs).toHaveLength(0);
    expect(await alarmAt(stub)).toBe(now + CHANNEL_DISABLED_RETRY_MS);
  });

  it("daily cap defers to UTC midnight", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-cap");
    await initBot(stub);
    await patchMeta(stub, { wakesDay: utcDay(now), wakesCount: 48 });

    await fireAlarm(stub);
    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(0);
    const midnight = nextUtcMidnight(now);
    expect((await stub.snapshot())?.meta.nextWakeAt).toBe(midnight);
    expect(await alarmAt(stub)).toBe(midnight);
    expect(fake.notices).toHaveLength(1);
    expect(fake.notices[0]?.text).toBe(
      "⏸ 价格哨兵 今日唤醒已达 48 次，推迟到明天 00:00 UTC",
    );
  });

  it("daily counter resets at UTC midnight", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-new-day");
    await initBot(stub);
    await patchMeta(stub, {
      wakesDay: utcDay(now - 86_400_000),
      wakesCount: 48,
    });

    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(1);
    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.wakesDay).toBe(utcDay(now));
    expect(snapshot?.meta.wakesCount).toBe(1);
  });

  it("paused bot records run but does not reschedule", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-paused");
    await initBot(stub);
    await stub.pause();
    expect(await alarmAt(stub)).toBeNull();

    await stub.onRunEnded("t-late", "completed", "跑完了");

    const snapshot = await stub.snapshot();
    expect(snapshot?.runs).toHaveLength(1);
    expect(snapshot?.meta.status).toBe("paused");
    expect(await alarmAt(stub)).toBeNull();
  });

  it("maintenance defers the alarm", async () => {
    const fake = fakeButler();
    fake.maintenanceThrows = true;
    const stub = botStub("b-lifecycle-maintenance");
    await initBot(stub);

    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(0);
    expect(await alarmAt(stub)).toBe(now + DEFER_MS);
  });

  it("destroyed bot ignores late calls", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-destroyed");
    await initBot(stub);

    await stub.destroy();
    const remembered = await stub.remember("迟到的记忆");
    await stub.onRunEnded("t-late", "completed", "跑完了");

    expect(remembered).toBe(-1);
    expect(await stub.snapshot()).toBeNull();
    expect(await alarmAt(stub)).toBeNull();
  });

  it("steer is consumed by the next run", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-steer");
    await initBot(stub);

    expect(await stub.steer("先看主站")).toEqual({ currentTaskId: null });
    await fireAlarm(stub);

    expect(fake.spawns[0]?.instructions).toContain("先看主站");
    expect((await stub.snapshot())?.meta.pendingSteer).toEqual([]);
  });
});
