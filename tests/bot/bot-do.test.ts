import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFER_MS } from "../../src/admin/maintenance";
import {
  BotDO,
  setBotButlerOverride,
  setBotTaskOverride,
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
  MIN_WAKE_MS,
  WATCHDOG_MS,
  nextUtcMidnight,
  utcDay,
} from "../../src/bot/wake";
import { buildBotInstructions } from "../../src/bot/instructions";
import { setClockOverride } from "../../src/butler/notifier";
import { QUOTA_EXHAUSTED_TEXT } from "../../src/llm/model-errors";

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
  outcomeCalls: number;
  spawnGate: Promise<void> | null;
  outcomeGate: Promise<void> | null;
  maintenance: boolean;
  maintenanceThrows: boolean;
  profile: string | Error;
};

/** A Butler stand-in that records calls and answers from mutable state. */
function fakeButler(): FakeState {
  const state: FakeState = {
    spawns: [],
    notices: [],
    spawnResult: (index) => ({ ok: true, taskId: `t${index}` }),
    outcome: { outcome: null, summary: "" },
    outcomeCalls: 0,
    spawnGate: null,
    outcomeGate: null,
    maintenance: false,
    maintenanceThrows: false,
    profile: "",
  };

  const butler: BotButler = {
    async spawnForBot(botId, title, instructions) {
      state.spawns.push({ botId, title, instructions });
      if (state.spawnGate !== null) await state.spawnGate;
      return state.spawnResult(state.spawns.length);
    },
    async botTaskOutcome() {
      state.outcomeCalls += 1;
      if (state.outcomeGate !== null) await state.outcomeGate;
      return state.outcome;
    },
    async botNotice(botId, text) {
      state.notices.push({ botId, text });
    },
    async ownerProfile() {
      if (state.profile instanceof Error) throw state.profile;
      return state.profile;
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Polls until the alarm reached the awaited RPC. */
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((done) => setTimeout(done, 0));
  }
  expect(condition()).toBe(true);
}

/** A Task DO stand-in that records cancels. */
function taskStub(cancelled: string[]) {
  return (taskId: string) => ({
    cancel: async () => {
      cancelled.push(taskId);
      return { ok: true, message: "" };
    },
  });
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
  setBotTaskOverride(null);
  setClockOverride(null);
  vi.restoreAllMocks();
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

  it("an exhausted model allowance does not pause the bot", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-quota");
    await initBot(stub);
    await stub.onRunEnded("t-fail", "failed", "boom");
    expect((await stub.snapshot())?.meta.consecutiveFailures).toBe(1);

    await stub.onRunEnded("t-quota-1", "failed", QUOTA_EXHAUSTED_TEXT);
    await stub.onRunEnded("t-quota-2", "failed", QUOTA_EXHAUSTED_TEXT);
    await stub.onRunEnded("t-quota-3", "failed", QUOTA_EXHAUSTED_TEXT);

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.status).toBe("active");
    expect(snapshot?.meta.consecutiveFailures).toBe(1);
    expect(snapshot?.meta.nextWakeAt).not.toBeNull();
    expect(await alarmAt(stub)).toBe(snapshot?.meta.nextWakeAt);
  });

  it("ordinary failures still pause the bot", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-pause-control");
    await initBot(stub);

    await stub.onRunEnded("t-1", "failed", "boom");
    await stub.onRunEnded("t-2", "failed", "boom");
    await stub.onRunEnded("t-3", "failed", "boom");

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.status).toBe("paused");
    expect(snapshot?.meta.consecutiveFailures).toBe(3);
    expect(await alarmAt(stub)).toBeNull();
  });

  it("does not spawn when a fast run already scheduled a later wake", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-fast-run");
    await initBot(stub);
    // The run reported back before the alarm fired and already scheduled the
    // next wake, so this alarm is not due yet.
    await stub.onRunEnded("t1", "completed", "抢跑");

    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(0);

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
    const wrote = await stub.writeDoc("记忆", "迟到的记忆", {
      allowRules: false,
    });
    await stub.onRunEnded("t-late", "completed", "跑完了");

    expect(wrote).toEqual({ ok: false, message: "机器人不存在" });
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

  it("keeps steer that arrives during dispatch", async () => {
    const fake = fakeButler();
    const stub = botStub("b-steer-during-dispatch");
    await initBot(stub);
    await stub.steer("先看主站");
    const gate = deferred();
    fake.spawnGate = gate.promise;

    const fired = runDurableObjectAlarm(stub);
    await waitUntil(() => fake.spawns.length === 1);
    await stub.steer("再看备份站");
    gate.resolve();
    await fired;

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.pendingSteer).toEqual(["再看备份站"]);
    expect(fake.spawns[0]?.instructions).toContain("先看主站");
    expect(fake.spawns[0]?.instructions).not.toContain("再看备份站");
  });

  it("does not spawn before the saved wake time", async () => {
    const fake = fakeButler();
    const stub = botStub("b-not-due");
    await initBot(stub);
    await stub.setNextWake({ at: now + 7_200_000 });

    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(0);
    expect(await alarmAt(stub)).toBe(now + 7_200_000);
  });

  it("watchdog ignores an outcome after the bot is destroyed", async () => {
    const fake = fakeButler();
    const stub = botStub("b-watchdog-destroyed");
    await initBot(stub);
    await fireAlarm(stub);
    const gate = deferred();
    fake.outcome = { outcome: "completed", summary: "看完了" };
    fake.outcomeGate = gate.promise;

    const fired = runDurableObjectAlarm(stub);
    await waitUntil(() => fake.outcomeCalls === 1);
    await stub.destroy();
    gate.resolve();
    await fired;

    expect(await stub.snapshot()).toBeNull();
  });

  it("destroy during dispatch cancels the new task", async () => {
    const fake = fakeButler();
    const stub = botStub("b-destroy-during-dispatch");
    await initBot(stub);
    const cancelled: string[] = [];
    setBotTaskOverride(taskStub(cancelled));
    const gate = deferred();
    fake.spawnGate = gate.promise;

    const fired = runDurableObjectAlarm(stub);
    await waitUntil(() => fake.spawns.length === 1);
    await stub.destroy();
    gate.resolve();
    await fired;

    expect(cancelled).toEqual(["t1"]);
    expect(await stub.snapshot()).toBeNull();
  });

  it("pause during dispatch cancels and records the run", async () => {
    const fake = fakeButler();
    const stub = botStub("b-pause-during-dispatch");
    await initBot(stub);
    const cancelled: string[] = [];
    setBotTaskOverride(taskStub(cancelled));
    const gate = deferred();
    fake.spawnGate = gate.promise;

    const fired = runDurableObjectAlarm(stub);
    await waitUntil(() => fake.spawns.length === 1);
    await stub.pause();
    gate.resolve();
    await fired;

    expect(cancelled).toEqual(["t1"]);
    const paused = await stub.snapshot();
    expect(paused?.runs).toEqual([
      expect.objectContaining({ taskId: "t1", outcome: null }),
    ]);
    expect(paused?.meta.currentTaskId).toBe("t1");
    expect(await alarmAt(stub)).toBeNull();

    await stub.onRunEnded("t1", "cancelled", "停掉了");
    const ended = await stub.snapshot();
    expect(ended?.meta.currentTaskId).toBeNull();
    expect(ended?.runs[0]).toMatchObject({
      outcome: "cancelled",
      summary: "停掉了",
    });
  });

  it("a run that ends during dispatch is not left current", async () => {
    const fake = fakeButler();
    const stub = botStub("b-ends-during-dispatch");
    await initBot(stub);
    const gate = deferred();
    fake.spawnGate = gate.promise;

    const fired = runDurableObjectAlarm(stub);
    await waitUntil(() => fake.spawns.length === 1);
    await stub.onRunEnded("t1", "completed", "很快");
    gate.resolve();
    await fired;

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.currentTaskId).toBeNull();
    expect(snapshot?.runs).toHaveLength(1);
    expect(await alarmAt(stub)).toBe(now + snapshot!.meta.defaultIntervalMs);
  });

  it("a paused bot whose run ended during dispatch is released on resume", async () => {
    const fake = fakeButler();
    const stub = botStub("b-pause-ends-during-dispatch");
    await initBot(stub);
    setBotTaskOverride(taskStub([]));
    const gate = deferred();
    fake.spawnGate = gate.promise;

    const fired = runDurableObjectAlarm(stub);
    await waitUntil(() => fake.spawns.length === 1);
    await stub.pause();
    await stub.onRunEnded("t1", "completed", "很快");
    gate.resolve();
    await fired;

    await stub.resume(false);
    fake.outcome = { outcome: "completed", summary: "很快" };
    await fireAlarm(stub);

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.currentTaskId).toBeNull();
    expect(await alarmAt(stub)).not.toBeNull();
  });

  it("cancels a run stuck for more than a day", async () => {
    const fake = fakeButler();
    const stub = botStub("b-stuck-run");
    await initBot(stub);
    await fireAlarm(stub);
    const cancelled: string[] = [];
    setBotTaskOverride(taskStub(cancelled));

    now += 25 * 3_600_000;
    await fireAlarm(stub);

    expect(cancelled).toEqual(["t1"]);
    const snapshot = await stub.snapshot();
    expect(snapshot?.runs[0]).toMatchObject({
      taskId: "t1",
      outcome: "failed",
      summary: "运行超过 24 小时，已取消",
    });
    expect(snapshot?.meta.consecutiveFailures).toBe(1);
    expect(snapshot?.meta.currentTaskId).toBeNull();
  });

  it("ignores the end of a run that is not current", async () => {
    fakeButler();
    const stub = botStub("b-stale-run-end");
    await initBot(stub);
    await stub.setNextWake({ at: now + 7_200_000 });
    await patchMeta(stub, { currentTaskId: "t2" });
    const before = await alarmAt(stub);

    await stub.onRunEnded("t1", "failed", "boom");

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.consecutiveFailures).toBe(0);
    expect(snapshot?.meta.nextWakeAt).toBe(now + 7_200_000);
    expect(await alarmAt(stub)).toBe(before);
    expect(snapshot?.runs).toEqual([
      expect.objectContaining({ taskId: "t1", outcome: "failed" }),
    ]);
  });

  it("wakeNow during a run defers to the end of the run", async () => {
    fakeButler();
    const stub = botStub("b-wake-now-running");
    await initBot(stub);
    await fireAlarm(stub);

    expect(await stub.wakeNow()).toBe("after_run");

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.nextWakeAt).toBe(now + MIN_WAKE_MS);
    expect(await alarmAt(stub)).toBe(now + WATCHDOG_MS);
  });

  it("wakeNow on a paused bot does nothing", async () => {
    fakeButler();
    const stub = botStub("b-wake-now-paused");
    await initBot(stub);
    await stub.pause();

    expect(await stub.wakeNow()).toBe("inactive");

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.status).toBe("paused");
    expect(snapshot?.meta.nextWakeAt).toBeNull();
    expect(await alarmAt(stub)).toBeNull();
  });

  it("wakeNow schedules an immediate wake", async () => {
    fakeButler();
    const stub = botStub("b-wake-now-idle");
    await initBot(stub);
    await stub.setNextWake({ at: now + 7_200_000 });

    expect(await stub.wakeNow()).toBe("scheduled");

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.nextWakeAt).toBe(now);
    expect(await alarmAt(stub)).toBe(now);
  });

  it("maintenance spawn result defers without counting", async () => {
    const fake = fakeButler();
    fake.spawnResult = () => ({
      ok: false,
      reason: "maintenance",
      message: "维护中",
    });
    const stub = botStub("b-spawn-maintenance");
    await initBot(stub);

    await fireAlarm(stub);

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.wakesCount).toBe(0);
    expect(snapshot?.meta.consecutiveFailures).toBe(0);
    expect(snapshot?.runs).toHaveLength(0);
    expect(await alarmAt(stub)).toBe(now + DEFER_MS);
  });
  it("set_next_wake after finish_bot in the same run keeps the bot waking", async () => {
    const fake = fakeButler();
    const stub = botStub("b-finish-then-wake");
    await initBot(stub);
    await fireAlarm(stub);

    // A model that mistakes finish_bot for finish_task, then schedules itself.
    await stub.finish("本次检查完成");
    const result = await stub.setNextWake({ afterMs: 7_200_000 });
    await stub.onRunEnded("t1", "completed", "看完了");

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.status).toBe("active");
    expect(snapshot?.meta.nextWakeAt).toBe(result.at);
    expect(await alarmAt(stub)).toBe(result.at);
    expect(fake.notices).toHaveLength(0);
  });

  it("a finished bot tells the owner when its last run ends", async () => {
    const fake = fakeButler();
    const stub = botStub("b-finish-notice");
    await initBot(stub);
    await fireAlarm(stub);

    await stub.finish("价格已降到目标");
    await stub.onRunEnded("t1", "completed", "看完了");

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.status).toBe("finished");
    expect(await alarmAt(stub)).toBeNull();
    expect(fake.notices).toHaveLength(1);
    expect(fake.notices[0]!.text).toContain("价格已降到目标");
  });

  it("setNextWake does not wake a paused bot", async () => {
    fakeButler();
    const stub = botStub("b-paused-set-wake");
    await initBot(stub);
    await stub.pause();

    await stub.setNextWake({ afterMs: 7_200_000 });

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.status).toBe("paused");
    expect(await alarmAt(stub)).toBeNull();
  });
});

describe("BotDO documents", () => {
  it("writes the initial rules during init", async () => {
    fakeButler();
    const stub = botStub("b-docs-init");
    await initBot(stub, { rules: "凌晨不发消息" });

    expect((await stub.snapshot())?.docs).toEqual([
      { name: "守则", content: "凌晨不发消息" },
    ]);
  });

  it("writes and deletes documents with the shared rules", async () => {
    fakeButler();
    const stub = botStub("b-docs-write");
    await initBot(stub);

    expect(
      await stub.writeDoc(" 方法 ", " 先看主站 ", { allowRules: false }),
    ).toEqual({ ok: true, message: "已写入「方法」（4/6000 字）" });
    expect((await stub.snapshot())?.docs).toEqual([
      { name: "方法", content: "先看主站" },
    ]);

    expect(await stub.writeDoc("守则", "x", { allowRules: false })).toEqual({
      ok: false,
      message: "「守则」不能直接写，请用 propose_rules 提议",
    });

    expect(await stub.writeDoc("方法", "", { allowRules: false })).toEqual({
      ok: true,
      message: "已删除「方法」",
    });
    expect(await stub.writeDoc("不存在", "", { allowRules: false })).toEqual({
      ok: false,
      message: "没有文档「不存在」",
    });
  });

  it("reports a missing bot", async () => {
    fakeButler();
    const stub = botStub("b-docs-missing");

    expect(
      await stub.writeDoc("方法", "先看主站", { allowRules: false }),
    ).toEqual({ ok: false, message: "机器人不存在" });
    expect(await stub.searchRuns("价格")).toEqual([]);
  });

  it("renders documents and the owner profile on wake", async () => {
    const fake = fakeButler();
    const stub = botStub("b-docs-wake");
    await initBot(stub);
    await stub.writeDoc("守则", "凌晨不发消息", { allowRules: true });
    await stub.writeDoc("方法B", "再看备份", { allowRules: false });
    await stub.writeDoc("方法A", "先看主站", { allowRules: false });
    await stub.writeDoc("记忆", "上次价格 239", { allowRules: false });
    fake.profile = "- 时区 UTC+8";

    await fireAlarm(stub);

    const snapshot = await stub.snapshot();
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]!.instructions).toBe(
      buildBotInstructions({
        name: "价格哨兵",
        mission: "盯着价格",
        docs: snapshot!.docs,
        ownerProfile: "- 时区 UTC+8",
        runs: [],
        steer: [],
        manualWake: false,
      }),
    );
  });

  it("spawns without the owner profile when the Butler fails", async () => {
    const fake = fakeButler();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = botStub("b-docs-profile-down");
    await initBot(stub);
    fake.profile = new Error("down");

    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]!.instructions).not.toContain("关于主人：");
    expect(warn).toHaveBeenCalled();
  });
});

describe("BotDO legacy memory migration", () => {
  function seedLegacyMemories(sql: SqlStorage, contents: string[]): void {
    sql.exec(
      `CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    for (const content of contents) {
      sql.exec(
        `INSERT INTO memories (content, created_at) VALUES (?, ?)`,
        content,
        1,
      );
    }
  }

  const meta: BotMeta = {
    botId: "b1",
    name: "价格哨兵",
    mission: "盯着价格",
    status: "active",
    nextWakeAt: null,
    defaultIntervalMs: 86_400_000,
    currentTaskId: null,
    consecutiveFailures: 0,
    wakesDay: null,
    wakesCount: 0,
    pendingSteer: [],
  };

  it("leaves a partial memories table alone until meta is restored", async () => {
    const result = await runInDurableObject(
      botStub("b-migrate-partial"),
      (_instance, state) => {
        const sql = state.storage.sql;
        seedLegacyMemories(sql, ["喜欢绿茶"]);
        new BotDO(state, env);
        return {
          meta: new BotStore(sql).readMeta(),
          docs: new BotStore(sql).readDocs(),
          rows: sql
            .exec<{ content: string }>(`SELECT content FROM memories`)
            .toArray(),
        };
      },
    );

    expect(result.meta).toBeNull();
    expect(result.docs).toEqual([]);
    expect(result.rows).toEqual([{ content: "喜欢绿茶" }]);
  });

  it("migrates legacy memories once meta exists", async () => {
    const result = await runInDurableObject(
      botStub("b-migrate-complete"),
      (_instance, state) => {
        const sql = state.storage.sql;
        seedLegacyMemories(sql, ["喜欢绿茶", "上次价格 239"]);
        new BotStore(sql).writeMeta(meta);
        new BotDO(state, env);
        return {
          docs: new BotStore(sql).readDocs(),
          legacy: sql
            .exec<{ name: string }>(
              `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'`,
            )
            .toArray(),
        };
      },
    );

    expect(result.docs).toEqual([
      { name: "记忆", content: "- 喜欢绿茶\n- 上次价格 239" },
    ]);
    expect(result.legacy).toEqual([]);
  });
});

describe("BotDO manual wakes", () => {
  it("marks a wakeNow wake and clears it after dispatch", async () => {
    const fake = fakeButler();
    const stub = botStub("b-manual-wake-now");
    await initBot(stub);

    expect(await stub.wakeNow()).toBe("scheduled");
    expect((await stub.snapshot())?.meta.manualWakeAt).toBe(now);

    await fireAlarm(stub);
    expect(fake.spawns[0]!.instructions).toContain(
      "唤醒原因：主人要求立即唤醒",
    );
    expect((await stub.snapshot())?.meta.manualWakeAt).toBeNull();

    fake.outcome = { outcome: "completed", summary: "看完了" };
    now += WATCHDOG_MS;
    await fireAlarm(stub);
    const scheduled = await stub.snapshot();
    expect(scheduled?.meta.currentTaskId).toBeNull();

    now = scheduled!.meta.nextWakeAt!;
    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(2);
    expect(fake.spawns[1]!.instructions).toContain("唤醒原因：按计划唤醒");
    expect(fake.spawns[1]!.instructions).not.toContain("主人要求立即唤醒");
  });

  it("marks a wake requested during a run that ends promptly", async () => {
    const fake = fakeButler();
    const stub = botStub("b-manual-wake-after-run");
    await initBot(stub);
    await fireAlarm(stub);

    now += 60_000;
    expect(await stub.wakeNow()).toBe("after_run");
    const requestedAt = now + MIN_WAKE_MS;
    expect((await stub.snapshot())?.meta.manualWakeAt).toBe(requestedAt);

    fake.outcome = { outcome: "completed", summary: "看完了" };
    now += 2 * 60_000; // ends well within the 5-minute minimum
    await fireAlarm(stub);
    const scheduled = await stub.snapshot();
    expect(scheduled?.meta.currentTaskId).toBeNull();
    expect(scheduled?.meta.nextWakeAt).toBe(now + MIN_WAKE_MS);

    now = scheduled!.meta.nextWakeAt!;
    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(2);
    expect(fake.spawns[1]!.instructions).toContain(
      "唤醒原因：主人要求立即唤醒",
    );
  });

  it("treats a wake rescheduled by the run as routine", async () => {
    const fake = fakeButler();
    const stub = botStub("b-manual-wake-rescheduled");
    await initBot(stub);
    await fireAlarm(stub);

    now += 60_000;
    expect(await stub.wakeNow()).toBe("after_run");
    await stub.setNextWake({ afterMs: 2 * 3_600_000 });

    fake.outcome = { outcome: "completed", summary: "看完了" };
    await fireAlarm(stub);
    const scheduled = await stub.snapshot();
    expect(scheduled?.meta.currentTaskId).toBeNull();

    now = scheduled!.meta.nextWakeAt!;
    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(2);
    expect(fake.spawns[1]!.instructions).toContain("唤醒原因：按计划唤醒");
    expect(fake.spawns[1]!.instructions).not.toContain("主人要求立即唤醒");
  });

  it("treats a slow run's fallback wake as routine", async () => {
    const fake = fakeButler();
    const stub = botStub("b-manual-wake-slow-run");
    await initBot(stub);
    await fireAlarm(stub);

    now += 60_000;
    expect(await stub.wakeNow()).toBe("after_run");

    fake.outcome = { outcome: "completed", summary: "看完了" };
    now += WATCHDOG_MS;
    await fireAlarm(stub);
    const scheduled = await stub.snapshot();
    expect(scheduled?.meta.currentTaskId).toBeNull();

    now = scheduled!.meta.nextWakeAt!;
    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(2);
    expect(fake.spawns[1]!.instructions).toContain("唤醒原因：按计划唤醒");
  });

  it("clears a manual wake when the bot is paused and resumed later", async () => {
    const fake = fakeButler();
    const stub = botStub("b-manual-wake-paused");
    await initBot(stub);
    await stub.wakeNow();
    await stub.pause();
    expect((await stub.snapshot())?.meta.manualWakeAt).toBeNull();

    await stub.resume(false);
    const resumed = await stub.snapshot();
    expect(resumed?.meta.manualWakeAt).toBeNull();

    now = resumed!.meta.nextWakeAt!;
    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]!.instructions).toContain("唤醒原因：按计划唤醒");
  });

  it("marks a resume with an immediate wake", async () => {
    const fake = fakeButler();
    const stub = botStub("b-manual-resume");
    await initBot(stub);
    await stub.pause();

    await stub.resume(true);
    expect((await stub.snapshot())?.meta.manualWakeAt).toBe(now);

    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]!.instructions).toContain(
      "唤醒原因：主人要求立即唤醒",
    );
  });
});

describe("BotDO rename", () => {
  it("rename keeps status, wake time and the armed alarm", async () => {
    fakeButler();
    const stub = botStub("b-rename");
    await initBot(stub, { firstWakeAt: now + 60_000 });
    const alarmBefore = await alarmAt(stub);

    const ok = await stub.rename("早报");

    expect(ok).toBe(true);
    const snapshot = await stub.snapshot();
    expect(snapshot?.meta).toMatchObject({
      botId: "b1",
      name: "早报",
      mission: "盯着价格",
      status: "active",
      nextWakeAt: now + 60_000,
      currentTaskId: null,
    });
    expect(await alarmAt(stub)).toBe(alarmBefore);
  });

  it("rename keeps an in-flight run", async () => {
    const fake = fakeButler();
    const stub = botStub("b-rename-running");
    await initBot(stub);
    await fireAlarm(stub);
    expect(fake.spawns).toHaveLength(1);
    expect(await alarmAt(stub)).toBe(now + WATCHDOG_MS);

    expect(await stub.rename("早报")).toBe(true);

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta).toMatchObject({
      name: "早报",
      currentTaskId: "t1",
      consecutiveFailures: 0,
    });
    expect(fake.spawns).toHaveLength(1);
    expect(await alarmAt(stub)).toBe(now + WATCHDOG_MS);
  });

  it("rename puts the new name on the next run", async () => {
    const fake = fakeButler();
    const stub = botStub("b-rename-next-run");
    await initBot(stub);
    await stub.rename("早报");

    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]).toMatchObject({ botId: "b1", title: "早报" });
    expect(fake.spawns[0]!.instructions).toContain("你是机器人 早报。");
  });

  it("rename does not re-arm a paused bot", async () => {
    fakeButler();
    const stub = botStub("b-rename-paused");
    await initBot(stub);
    await stub.pause();

    expect(await stub.rename("早报")).toBe(true);

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta).toMatchObject({
      name: "早报",
      status: "paused",
      nextWakeAt: null,
    });
    expect(await alarmAt(stub)).toBeNull();
  });

  it("rename returns false when the bot has no meta", async () => {
    const stub = botStub("b-rename-missing");

    expect(await stub.rename("早报")).toBe(false);
  });
});
