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
  DIET_RECHECK_MS,
  MIN_WAKE_MS,
  WATCHDOG_MS,
  nextUtcMidnight,
  utcDay,
} from "../../src/bot/wake";
import {
  CHAT_STEER_PREFIX,
  buildBotInstructions,
} from "../../src/bot/instructions";
import { setClockOverride } from "../../src/butler/notifier";
import type { SpendEntry } from "../../src/life/books";
import type { Tier } from "../../src/life/vitals";
import { QUOTA_EXHAUSTED_TEXT } from "../../src/llm/model-errors";
import { resetLife } from "../helpers/life";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const START = Date.UTC(2030, 0, 1, 9, 0, 0);
const DAY_MS = 86_400_000;

let now = START;

/** Drives the global life ledger to `tier`, moving the clock to seven days on. */
async function driveLifeTo(tier: Exclude<Tier, "ample">): Promise<void> {
  const life = env.LIFE.get(env.LIFE.idFromName("global"));
  await life.recordCredit(20, "");
  const daily = {
    lean: [1, 1, 1, 1, 1, 1, 1],
    critical: [2, 2, 2, 2, 2, 2, 7],
    dormant: [2, 2, 2, 2, 2, 2, 8],
  }[tier];
  for (let day = 0; day < daily.length; day += 1) {
    now = START + Math.round((day + 0.5) * DAY_MS);
    const entry: SpendEntry = {
      callId: crypto.randomUUID(),
      at: now,
      source: "task:test",
      provider: "test",
      model: "test",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usd: daily[day]!,
      priced: true,
    };
    await life.recordSpend(entry);
  }
  now = START + 7 * DAY_MS;
}

/** The ledger is shared with the rest of the file: make it ample again. */
async function makeLifeAmple(): Promise<void> {
  await env.LIFE.get(env.LIFE.idFromName("global")).recordCredit(
    1_000_000,
    "",
  );
}

type BotStub = ReturnType<typeof botStub>;

function botStub(name: string) {
  return env.BOT.get(env.BOT.idFromName(name));
}

type FakeState = {
  spawns: {
    botId: string;
    title: string;
    instructions: string;
    authorization?: string;
  }[];
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
    async spawnForBot(botId, title, instructions, authorization) {
      state.spawns.push({ botId, title, instructions, authorization });
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

async function deleteAlarm(stub: BotStub): Promise<void> {
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.deleteAlarm(),
  );
}

async function setRawAlarm(stub: BotStub, at: number): Promise<void> {
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.setAlarm(at),
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

  it("setDefaultInterval pulls a later wake in", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-interval-pull");
    await initBot(stub, { firstWakeAt: now + 86_400_000 });

    const result = await stub.setDefaultInterval(3_600_000);

    expect(result).toEqual({
      defaultIntervalMs: 3_600_000,
      nextWakeAt: now + 3_600_000,
    });
    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.nextWakeAt).toBe(now + 3_600_000);
    expect(await alarmAt(stub)).toBe(now + 3_600_000);
  });

  it("setDefaultInterval does not push an earlier wake out", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-interval-earlier");
    await initBot(stub, { firstWakeAt: now + 3_600_000 });

    const result = await stub.setDefaultInterval(7 * 86_400_000);

    expect(result).toEqual({
      defaultIntervalMs: 7 * 86_400_000,
      nextWakeAt: now + 3_600_000,
    });
    expect((await stub.snapshot())?.meta.nextWakeAt).toBe(now + 3_600_000);
    expect(await stub.setNextWake({ afterMs: 3 * 86_400_000 })).toEqual({
      at: now + 3 * 86_400_000,
      clamped: false,
    });
  });

  it("setDefaultInterval during a run keeps the watchdog", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-interval-run");
    await initBot(stub);
    await fireAlarm(stub);
    expect(await alarmAt(stub)).toBe(now + WATCHDOG_MS);

    await stub.setDefaultInterval(3_600_000);

    expect((await stub.snapshot())?.meta.defaultIntervalMs).toBe(3_600_000);
    expect(await alarmAt(stub)).toBe(now + WATCHDOG_MS);
  });

  it("setDefaultInterval on a paused bot sets no alarm", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-interval-paused");
    await initBot(stub, { firstWakeAt: now + 86_400_000 });
    await stub.pause();

    const result = await stub.setDefaultInterval(3_600_000);

    expect(result).toEqual({
      defaultIntervalMs: 3_600_000,
      nextWakeAt: null,
    });
    expect(await alarmAt(stub)).toBeNull();
  });

  it("setDefaultInterval keeps a daily-limit defer", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-interval-daily-cap");
    await initBot(stub, { defaultIntervalMs: 86_400_000 });
    await patchMeta(stub, { wakesDay: utcDay(now), wakesCount: 48 });

    await fireAlarm(stub);
    expect(fake.notices).toHaveLength(1);

    await stub.setDefaultInterval(3_600_000);

    expect((await stub.snapshot())?.meta.nextWakeAt).toBe(
      nextUtcMidnight(now),
    );
    expect(await alarmAt(stub)).toBe(nextUtcMidnight(now));
    expect(fake.notices).toHaveLength(1);
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

  it("setNextWake caps at the default interval", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-interval-cap");
    await initBot(stub);

    const result = await stub.setNextWake({ afterMs: 3 * 86_400_000 });

    expect(result).toEqual({ at: now + 86_400_000, clamped: true });
    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.nextWakeAt).toBe(now + 86_400_000);
    expect(await alarmAt(stub)).toBe(now + 86_400_000);
  });

  it("a run that scheduled past the interval wakes at the interval", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-interval-cap-run");
    await initBot(stub);
    await fireAlarm(stub);

    await stub.setNextWake({ at: now + 10 * 86_400_000 });
    await stub.onRunEnded("t1", "completed", "ok");

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.nextWakeAt).toBe(now + 86_400_000);
    expect(await alarmAt(stub)).toBe(now + 86_400_000);
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

  it("ordinary failures keep the bot active", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-pause-control");
    await initBot(stub);

    await stub.onRunEnded("t-1", "failed", "boom");
    await stub.onRunEnded("t-2", "failed", "boom");
    await stub.onRunEnded("t-3", "failed", "boom");

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.status).toBe("active");
    expect(snapshot?.meta.consecutiveFailures).toBe(3);
    expect(await alarmAt(stub)).not.toBeNull();
    expect(fake.notices.filter((n) => n.text.includes("暂停"))).toHaveLength(
      0,
    );
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

  it("failures back off and keep retrying", async () => {
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

    let snapshot = await stub.snapshot();
    expect(snapshot?.meta.status).toBe("active");
    expect(await alarmAt(stub)).toBe(now + 21_600_000);
    expect(fake.notices).toEqual([
      {
        botId: "b1",
        text: "连续 3 次失败（最近原因：boom），会继续每 6h 重试一次",
      },
    ]);

    now += 21_600_000;
    await fireAlarm(stub);
    expect(fake.spawns).toHaveLength(4);
    now += WATCHDOG_MS;
    fake.outcome = { outcome: "failed", summary: "boom" };
    await fireAlarm(stub);

    snapshot = await stub.snapshot();
    expect(snapshot?.meta.status).toBe("active");
    expect(await alarmAt(stub)).toBe(now + 21_600_000);
    expect(fake.notices).toHaveLength(1);
  });

  it("recovery after repeated failures tells the owner", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-recovered");
    await initBot(stub);

    await stub.onRunEnded("t-1", "failed", "boom");
    await stub.onRunEnded("t-2", "failed", "boom");
    await stub.onRunEnded("t-3", "failed", "boom");
    await stub.onRunEnded("t-ok", "completed", "好了");

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.consecutiveFailures).toBe(0);
    expect(fake.notices.at(-1)).toEqual({
      botId: "b1",
      text: "已恢复正常",
    });
  });

  it("success after one failure stays quiet", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-quiet-recovery");
    await initBot(stub);

    await stub.onRunEnded("t-1", "failed", "boom");
    await stub.onRunEnded("t-ok", "completed", "好了");

    expect(fake.notices).toHaveLength(0);
  });

  it("failure retry ignores a later saved wake", async () => {
    fakeButler();
    const stub = botStub("b-lifecycle-failure-saved-wake");
    await initBot(stub);
    await fireAlarm(stub);

    await stub.setNextWake({ afterMs: 20 * 3_600_000 });
    await stub.onRunEnded("t1", "failed", "boom");

    expect(await alarmAt(stub)).toBe(now + 900_000);
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
      "今日唤醒已达 48 次，推迟到明天 00:00 UTC",
    );
  });

  it("daily cap defer is not capped by the interval", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-cap-interval");
    await initBot(stub, { defaultIntervalMs: 3_600_000 });
    await patchMeta(stub, { wakesDay: utcDay(now), wakesCount: 48 });

    await fireAlarm(stub);
    await fireAlarm(stub);

    expect(fake.spawns).toHaveLength(0);
    expect((await stub.snapshot())?.meta.nextWakeAt).toBe(
      nextUtcMidnight(now),
    );
    expect(await alarmAt(stub)).toBe(nextUtcMidnight(now));
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

  it("authorizes the review without memories", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-authorization");
    await initBot(stub);
    await stub.writeDoc("记忆", "记忆内容abc", { allowRules: false });

    await fireAlarm(stub);

    expect(fake.spawns[0]?.instructions).toContain("记忆内容abc");
    expect(fake.spawns[0]?.authorization).toContain("盯着价格");
    expect(fake.spawns[0]?.authorization).not.toContain("记忆内容abc");
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

  it("steer from chat asks the run to report", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-steer-from-chat");
    await initBot(stub);

    await stub.steer("查一下价格", { fromChat: true });
    await fireAlarm(stub);

    expect(fake.spawns[0]?.instructions).toContain(
      CHAT_STEER_PREFIX + "查一下价格",
    );
  });

  it("steer without the chat marker stays plain", async () => {
    const fake = fakeButler();
    const stub = botStub("b-lifecycle-steer-plain");
    await initBot(stub);

    await stub.steer("x");
    await fireAlarm(stub);

    expect(fake.spawns[0]?.instructions).toContain("- x\n");
    expect(fake.spawns[0]?.instructions).not.toContain(CHAT_STEER_PREFIX);
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

  it("a fast failure during dispatch keeps the failure retry", async () => {
    const fake = fakeButler();
    const stub = botStub("b-fails-during-dispatch");
    await initBot(stub, { defaultIntervalMs: 3_600_000 });
    await patchMeta(stub, { consecutiveFailures: 2 });
    const gate = deferred();
    fake.spawnGate = gate.promise;

    const fired = runDurableObjectAlarm(stub);
    await waitUntil(() => fake.spawns.length === 1);
    await stub.onRunEnded("t1", "failed", "boom");
    gate.resolve();
    await fired;

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.consecutiveFailures).toBe(3);
    expect(snapshot?.meta.nextWakeAt).toBe(now + 21_600_000);
    expect(await alarmAt(stub)).toBe(now + 21_600_000);
    expect(fake.notices).toHaveLength(1);
    expect(fake.notices[0]?.text).toContain("6h");
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
  it("a finished bot stays finished when the run schedules again", async () => {
    const fake = fakeButler();
    const stub = botStub("b-finish-then-wake");
    await initBot(stub);
    await fireAlarm(stub);

    await stub.finish("本次检查完成");
    await stub.setNextWake({ afterMs: 7_200_000 });
    await stub.onRunEnded("t1", "completed", "看完了");

    const snapshot = await stub.snapshot();
    expect(snapshot?.meta.status).toBe("finished");
    expect(await alarmAt(stub)).toBeNull();
    expect(fake.notices).toHaveLength(1);
    expect(fake.notices[0]!.text).toContain("本次检查完成");
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
        vitals: null,
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

describe("BotDO heal", () => {
  it("heal re-arms a vanished alarm at the saved time", async () => {
    const fake = fakeButler();
    const stub = botStub("b-heal-vanished");
    await initBot(stub, { firstWakeAt: now + 3_600_000 });
    await deleteAlarm(stub);

    expect(await stub.heal()).toBe("healed");
    expect(await alarmAt(stub)).toBe(now);

    await fireAlarm(stub);
    expect(fake.spawns).toHaveLength(0);
    expect(await alarmAt(stub)).toBe(now + 3_600_000);
  });

  it("heal wakes a due bot whose alarm vanished", async () => {
    const fake = fakeButler();
    const stub = botStub("b-heal-due-vanished");
    await initBot(stub, { firstWakeAt: now });
    await deleteAlarm(stub);

    expect(await stub.heal()).toBe("healed");
    await fireAlarm(stub);
    expect(fake.spawns).toHaveLength(1);
  });

  it("heal wakes an overdue alarm", async () => {
    fakeButler();
    const overdue = botStub("b-heal-overdue");
    await initBot(overdue, { firstWakeAt: now + 3_600_000 });
    await setRawAlarm(overdue, now - 700_000);
    expect(await overdue.heal()).toBe("healed");

    const recent = botStub("b-heal-recent");
    await initBot(recent, { firstWakeAt: now + 3_600_000 });
    await setRawAlarm(recent, now - 500_000);
    expect(await recent.heal()).toBe("ok");
  });

  it("heal wakes a bot sleeping past its ceiling", async () => {
    const fake = fakeButler();
    const stub = botStub("b-heal-ceiling");
    await initBot(stub);
    await patchMeta(stub, { nextWakeAt: now + 30 * 86_400_000 });
    await setRawAlarm(stub, now + 30 * 86_400_000);

    expect(await stub.heal()).toBe("healed");
    expect((await stub.snapshot())?.meta.nextWakeAt).toBe(now);

    await fireAlarm(stub);
    expect(fake.spawns).toHaveLength(1);
  });

  it("heal leaves a failure retry alone", async () => {
    fakeButler();
    const stub = botStub("b-heal-failure");
    await initBot(stub, { defaultIntervalMs: 3_600_000 });
    await stub.onRunEnded("t-1", "failed", "boom");
    await stub.onRunEnded("t-2", "failed", "boom");
    await stub.onRunEnded("t-3", "failed", "boom");
    const before = await alarmAt(stub);
    expect(before).toBe(now + 21_600_000);

    expect(await stub.heal()).toBe("ok");
    expect(await alarmAt(stub)).toBe(before);
  });

  it("heal leaves a daily-limit defer alone", async () => {
    fakeButler();
    const stub = botStub("b-heal-daily");
    await initBot(stub, { defaultIntervalMs: 3_600_000 });
    await patchMeta(stub, { wakesDay: utcDay(now), wakesCount: 48 });
    await fireAlarm(stub);
    await fireAlarm(stub);
    const before = await alarmAt(stub);
    expect(before).toBe(nextUtcMidnight(now));

    expect(await stub.heal()).toBe("ok");
    expect(await alarmAt(stub)).toBe(before);
  });

  it("heal re-arms a lost watchdog", async () => {
    const fake = fakeButler();
    const stub = botStub("b-heal-watchdog");
    await initBot(stub);
    await fireAlarm(stub);
    await deleteAlarm(stub);

    expect(await stub.heal()).toBe("healed");

    fake.outcome = { outcome: "completed", summary: "ok" };
    await fireAlarm(stub);

    const snapshot = await stub.snapshot();
    expect(fake.outcomeCalls).toBe(1);
    expect(snapshot?.meta.currentTaskId).toBeNull();
    expect(fake.spawns).toHaveLength(1);
  });

  it("heal skips paused, finished and missing bots", async () => {
    fakeButler();
    const paused = botStub("b-heal-paused");
    await initBot(paused);
    await paused.pause();
    expect(await paused.heal()).toBe("skipped");
    expect(await alarmAt(paused)).toBeNull();

    const finished = botStub("b-heal-finished");
    await initBot(finished);
    await finished.finish("x");
    expect(await finished.heal()).toBe("skipped");
    expect(await alarmAt(finished)).toBeNull();

    const missing = botStub("b-heal-missing");
    expect(await missing.heal()).toBe("skipped");
    expect(await alarmAt(missing)).toBeNull();
  });

  it("heal skips while an alarm is dispatching", async () => {
    const fake = fakeButler();
    const stub = botStub("b-heal-dispatching");
    await initBot(stub);
    const gate = deferred();
    fake.spawnGate = gate.promise;

    const fired = runDurableObjectAlarm(stub);
    await waitUntil(() => fake.spawns.length === 1);
    expect(await stub.heal()).toBe("skipped");

    gate.resolve();
    await fired;

    expect(fake.spawns).toHaveLength(1);
    expect(await alarmAt(stub)).toBe(now + WATCHDOG_MS);
  });

  it("heal twice spawns once", async () => {
    const fake = fakeButler();
    const stub = botStub("b-heal-twice");
    await initBot(stub);
    await deleteAlarm(stub);

    expect(await stub.heal()).toBe("healed");
    expect(await stub.heal()).toBe("ok");

    await fireAlarm(stub);
    expect(fake.spawns).toHaveLength(1);
  });
});

describe("BotDO diet", () => {
  it("holds a due wake when critical", async () => {
    const fake = fakeButler();
    try {
      await driveLifeTo("critical");
      const stub = botStub("b-diet-critical-hold");
      await initBot(stub);

      await fireAlarm(stub);

      expect(fake.spawns).toHaveLength(0);
      const snapshot = await stub.snapshot();
      expect(snapshot?.meta.nextWakeAt).toBe(now + DIET_RECHECK_MS);
      expect(snapshot?.meta.wakesCount).toBe(0);
      expect(snapshot?.meta.status).toBe("active");
      expect(fake.notices).toEqual([]);
      expect(await alarmAt(stub)).toBe(now + DIET_RECHECK_MS);
    } finally {
      await resetLife();
    }
  });

  it("runs a manual wake when critical", async () => {
    const fake = fakeButler();
    try {
      await driveLifeTo("critical");
      const stub = botStub("b-diet-critical-manual");
      await initBot(stub);

      expect(await stub.wakeNow()).toBe("scheduled");
      await fireAlarm(stub);

      expect(fake.spawns).toHaveLength(1);
      expect((await stub.snapshot())?.meta.currentTaskId).toBe("t1");
    } finally {
      await resetLife();
    }
  });

  it("resumes the schedule once the balance is ample again", async () => {
    const fake = fakeButler();
    try {
      await driveLifeTo("critical");
      const stub = botStub("b-diet-recovered");
      await initBot(stub);
      await fireAlarm(stub);
      expect(fake.spawns).toHaveLength(0);

      await makeLifeAmple();
      now += DIET_RECHECK_MS;
      await fireAlarm(stub);

      expect(fake.spawns).toHaveLength(1);
    } finally {
      await resetLife();
    }
  });

  it("doubles the gap after a normal run when lean", async () => {
    const fake = fakeButler();
    try {
      await driveLifeTo("lean");
      const stub = botStub("b-diet-lean-stretch");
      await initBot(stub);
      await fireAlarm(stub);

      fake.outcome = { outcome: "completed", summary: "看完了" };
      now += WATCHDOG_MS;
      await fireAlarm(stub);

      const snapshot = await stub.snapshot();
      expect(snapshot?.meta.currentTaskId).toBeNull();
      expect(snapshot!.meta.nextWakeAt! - now).toBe(
        2 * snapshot!.meta.defaultIntervalMs,
      );
      expect(await alarmAt(stub)).toBe(snapshot?.meta.nextWakeAt);
    } finally {
      await resetLife();
    }
  });

  it("heal leaves a diet hold alone", async () => {
    fakeButler();
    try {
      await driveLifeTo("critical");
      const stub = botStub("b-diet-heal");
      await initBot(stub);
      await fireAlarm(stub);

      expect(await stub.heal()).toBe("ok");
      expect(await alarmAt(stub)).toBe(now + DIET_RECHECK_MS);
    } finally {
      await resetLife();
    }
  });

  it("heal tolerates a wake stretched by the lean tier", async () => {
    const fake = fakeButler();
    try {
      await driveLifeTo("lean");
      const stub = botStub("b-diet-lean-heal");
      await initBot(stub, { defaultIntervalMs: 12 * 3_600_000 });
      await fireAlarm(stub);

      fake.outcome = { outcome: "completed", summary: "看完了" };
      now += WATCHDOG_MS;
      await fireAlarm(stub);

      const scheduled = await stub.snapshot();
      expect(scheduled!.meta.nextWakeAt! - now).toBe(24 * 3_600_000);
      expect(await stub.heal()).toBe("ok");
      expect((await stub.snapshot())?.meta.nextWakeAt).toBe(
        scheduled?.meta.nextWakeAt,
      );

      await makeLifeAmple();
      expect(await stub.heal()).toBe("healed");
    } finally {
      await resetLife();
    }
  });
});
