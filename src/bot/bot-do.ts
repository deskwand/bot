import { DurableObject } from "cloudflare:workers";
import { BackupRpc } from "../admin/backup-rpc";
import { DEFER_MS } from "../admin/maintenance";
import type {
  DbSchema,
  DumpPage,
  DumpRow,
  TableSchema,
} from "../admin/sql-dump";
import { MemoryStore, type MemoryItem } from "../butler/memory";
import { getClock } from "../butler/notifier";
import {
  BotStore,
  type BotMeta,
  type RunOutcome,
  type RunRow,
} from "./bot-store";
import { buildBotInstructions } from "./instructions";
import {
  CHANNEL_DISABLED_RETRY_MS,
  DAILY_WAKE_LIMIT,
  MIN_WAKE_MS,
  PAUSE_AFTER_FAILURES,
  WATCHDOG_MS,
  clampWakeAt,
  failureDelayMs,
  nextUtcMidnight,
  utcDay,
} from "./wake";

export type BotInit = {
  botId: string;
  name: string;
  mission: string;
  defaultIntervalMs: number;
  firstWakeAt: number;
};

export type BotSnapshot = {
  meta: BotMeta;
  memories: MemoryItem[];
  runs: RunRow[];
};

export type SpawnForBotResult =
  | { ok: true; taskId: string }
  | {
      ok: false;
      reason: "channel_disabled" | "failed";
      message: string;
    };

/** The Butler RPCs a bot depends on. Structural so tests can inject a fake. */
export type BotButler = {
  spawnForBot(
    botId: string,
    title: string,
    instructions: string,
  ): Promise<SpawnForBotResult>;
  botTaskOutcome(
    taskId: string,
  ): Promise<{ outcome: RunOutcome | null; summary: string }>;
  botNotice(botId: string, text: string): Promise<void>;
  maintenanceActive(): Promise<boolean>;
};

let butlerOverride: BotButler | null = null;

/** Test-only Butler override, mirroring `setChannelOverride`. */
export function setBotButlerOverride(stub: BotButler | null): void {
  butlerOverride = stub;
}

/**
 * Long-lived identity for one autonomous bot: mission, memories, run log and
 * wake time. It never runs a model; every wake goes through the Butler, which
 * dispatches a TaskDO and reports the outcome back here.
 */
export class BotDO extends DurableObject<Env> {
  store: BotStore;

  memories: MemoryStore;

  private readonly backup: BackupRpc;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new BotStore(ctx.storage.sql);
    this.memories = new MemoryStore(ctx.storage.sql);
    // Bots have no maintenance lease of their own; the Butler holds it.
    this.backup = new BackupRpc(ctx, null);
  }

  async backupSchema(): Promise<DbSchema> {
    return this.backup.backupSchema();
  }

  async backupPage(
    table: TableSchema,
    cursor: string | null,
  ): Promise<DumpPage> {
    return this.backup.backupPage(table, cursor);
  }

  async restoreBegin(schema: DbSchema): Promise<void> {
    await this.backup.restoreBegin(schema);
  }

  async restorePage(table: TableSchema, rows: DumpRow[]): Promise<void> {
    await this.backup.restorePage(table, rows);
  }

  async restoreCommit(schema: DbSchema): Promise<void> {
    await this.backup.restoreCommit(schema);
    const meta = this.store.readMeta();
    if (meta === null) return;

    const now = getClock().now();
    if (meta.currentTaskId !== null) {
      // The task may be gone: the watchdog asks the Butler and records the run.
      await this.ctx.storage.setAlarm(now + WATCHDOG_MS);
      return;
    }
    const next = meta.nextWakeAt ?? now;
    // A wake time saved before the restore is usually stale; still respect the
    // minimum interval so the bot does not spin right after coming back.
    await this.ctx.storage.setAlarm(Math.max(next, now + MIN_WAKE_MS));
  }

  async restoreReset(): Promise<void> {
    this.backup.restoreReset();
  }

  async init(spec: BotInit): Promise<void> {
    if (this.store.readMeta() !== null) return;
    const meta: BotMeta = {
      botId: spec.botId,
      name: spec.name,
      mission: spec.mission,
      status: "active",
      nextWakeAt: spec.firstWakeAt,
      defaultIntervalMs: spec.defaultIntervalMs,
      currentTaskId: null,
      consecutiveFailures: 0,
      wakesDay: utcDay(getClock().now()),
      wakesCount: 0,
      pendingSteer: [],
    };
    this.store.writeMeta(meta);
    await this.ctx.storage.setAlarm(spec.firstWakeAt);
  }

  async snapshot(): Promise<BotSnapshot | null> {
    const meta = this.store.readMeta();
    if (meta === null) return null;
    return {
      meta,
      memories: this.memories.all(),
      runs: this.store.recentRuns(5),
    };
  }

  async remember(content: string): Promise<number> {
    if (this.store.readMeta() === null) return -1;
    return this.memories.add(content);
  }

  async forget(id: number): Promise<boolean> {
    if (this.store.readMeta() === null) return false;
    return this.memories.remove(id);
  }

  /**
   * Saves the next wake time. During a run this only updates meta: the
   * watchdog alarm stays armed and the end of the run picks the saved time.
   */
  async setNextWake(req: {
    afterMs?: number;
    at?: number;
  }): Promise<{ at: number; clamped: boolean }> {
    const meta = this.store.readMeta();
    if (meta === null) throw new Error("机器人不存在");

    const now = getClock().now();
    const requested = req.at ?? now + (req.afterMs ?? 0);
    const { at, clamped } = clampWakeAt(now, requested);
    meta.nextWakeAt = at;
    this.store.writeMeta(meta);
    if (meta.currentTaskId === null && meta.status === "active") {
      await this.ctx.storage.setAlarm(at);
    }
    return { at, clamped };
  }

  async note(taskId: string, text: string): Promise<void> {
    if (this.store.readMeta() === null) return;
    this.store.setRunNote(taskId, text);
  }

  async steer(text: string): Promise<{ currentTaskId: string | null }> {
    const meta = this.store.readMeta();
    if (meta === null) return { currentTaskId: null };
    meta.pendingSteer.push(text);
    this.store.writeMeta(meta);
    return { currentTaskId: meta.currentTaskId };
  }

  async wakeNow(): Promise<void> {
    const meta = this.store.readMeta();
    if (meta === null || meta.status !== "active") return;
    const now = getClock().now();
    meta.nextWakeAt = now;
    this.store.writeMeta(meta);
    if (meta.currentTaskId === null) {
      await this.ctx.storage.setAlarm(now);
    }
  }

  async pause(): Promise<void> {
    const meta = this.store.readMeta();
    if (meta === null) return;
    meta.status = "paused";
    meta.nextWakeAt = null;
    this.store.writeMeta(meta);
    await this.ctx.storage.deleteAlarm();
  }

  async resume(wakeNow: boolean): Promise<void> {
    const meta = this.store.readMeta();
    if (meta === null) return;
    const now = getClock().now();
    meta.status = "active";
    meta.consecutiveFailures = 0;
    meta.nextWakeAt = wakeNow
      ? now
      : clampWakeAt(now, now + meta.defaultIntervalMs).at;
    this.store.writeMeta(meta);
    // Pausing deleted the watchdog: check an in-flight run right away so a
    // lost outcome cannot leave the bot stuck on it.
    await this.ctx.storage.setAlarm(
      meta.currentTaskId === null ? meta.nextWakeAt : now,
    );
  }

  async finish(reason: string): Promise<void> {
    const meta = this.store.readMeta();
    if (meta === null) return;
    meta.status = "finished";
    meta.nextWakeAt = null;
    this.store.writeMeta(meta);
    await this.ctx.storage.deleteAlarm();
  }

  async onRunEnded(
    taskId: string,
    outcome: RunOutcome,
    summary: string,
  ): Promise<void> {
    const now = getClock().now();
    const meta = this.store.readMeta();
    if (meta === null) return;
    if (!this.store.endRun(taskId, outcome, summary, now)) return;

    if (outcome === "completed") meta.consecutiveFailures = 0;
    if (meta.currentTaskId === taskId) meta.currentTaskId = null;

    if (outcome === "failed" && meta.status === "active") {
      this.store.writeMeta(meta);
      await this.armAfterFailure(meta, now, summary);
      return;
    }

    this.store.writeMeta(meta);
    if (meta.status !== "active") return;

    meta.nextWakeAt = clampWakeAt(now, nextBase(meta, now)).at;
    this.store.writeMeta(meta);
    await this.ctx.storage.setAlarm(meta.nextWakeAt);
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // `deleteAll` also drops the SQL tables. Rebuild empty stores so late
    // RPCs see a missing meta row instead of failing on a missing table.
    this.store = new BotStore(this.ctx.storage.sql);
    this.memories = new MemoryStore(this.ctx.storage.sql);
  }

  async alarm(): Promise<void> {
    const now = getClock().now();

    let maintenanceActive: boolean;
    try {
      maintenanceActive = await this.butler().maintenanceActive();
    } catch {
      // Fail closed like TaskDO: an unknown lease state must not run a bot.
      await this.ctx.storage.setAlarm(now + DEFER_MS);
      return;
    }
    if (maintenanceActive) {
      await this.ctx.storage.setAlarm(now + DEFER_MS);
      return;
    }

    const meta = this.store.readMeta();
    if (meta === null || meta.status !== "active") return;

    if (meta.currentTaskId !== null) {
      await this.checkRunningTask(meta, now);
      return;
    }

    const day = utcDay(now);
    if (meta.wakesDay !== day) {
      meta.wakesDay = day;
      meta.wakesCount = 0;
      this.store.writeMeta(meta);
    }
    if (meta.wakesCount >= DAILY_WAKE_LIMIT) {
      await this.deferForDailyLimit(meta, now);
      return;
    }

    const instructions = buildBotInstructions({
      name: meta.name,
      mission: meta.mission,
      memories: this.memories.all(),
      runs: this.store.recentRuns(3),
      steer: meta.pendingSteer,
    });

    let result: SpawnForBotResult;
    try {
      result = await this.butler().spawnForBot(
        meta.botId,
        meta.name,
        instructions,
      );
    } catch (error) {
      const current = this.store.readMeta();
      if (current !== null && current.status === "active") {
        await this.armAfterFailure(current, now, errorMessage(error));
      }
      return;
    }

    if (!result.ok) {
      if (result.reason === "channel_disabled") {
        await this.ctx.storage.setAlarm(now + CHANNEL_DISABLED_RETRY_MS);
      } else {
        const current = this.store.readMeta();
        if (current !== null && current.status === "active") {
          await this.armAfterFailure(current, now, result.message);
        }
      }
      return;
    }

    const current = this.store.readMeta();
    if (current === null) return;
    current.wakesCount += 1;
    current.pendingSteer = [];
    this.store.writeMeta(current);

    this.store.insertRun(result.taskId, now);
    if (this.store.runEnded(result.taskId)) {
      // The task reported back before spawn returned and onRunEnded already
      // recorded the run. Re-arm in case that report raced this alarm.
      const ended = this.store.readMeta();
      if (ended !== null && ended.status === "active") {
        const at = clampWakeAt(now, nextBase(ended, now)).at;
        if (ended.nextWakeAt !== at) {
          ended.nextWakeAt = at;
          this.store.writeMeta(ended);
        }
        await this.ctx.storage.setAlarm(at);
      }
      return;
    }

    // Keep nextWakeAt: the run may already have called set_next_wake, and a
    // past value is ignored by nextBase anyway.
    current.currentTaskId = result.taskId;
    this.store.writeMeta(current);
    await this.ctx.storage.setAlarm(now + WATCHDOG_MS);
  }

  private butler(): BotButler {
    return (
      butlerOverride ??
      (this.env.BUTLER.get(
        this.env.BUTLER.idFromName("owner"),
      ) as unknown as BotButler)
    );
  }

  /** Watchdog path: ask the Butler whether the in-flight task has finished. */
  private async checkRunningTask(meta: BotMeta, now: number): Promise<void> {
    const taskId = meta.currentTaskId!;
    let result: { outcome: RunOutcome | null; summary: string };
    try {
      result = await this.butler().botTaskOutcome(taskId);
    } catch {
      await this.ctx.storage.setAlarm(now + WATCHDOG_MS);
      return;
    }
    if (result.outcome === null) {
      await this.ctx.storage.setAlarm(now + WATCHDOG_MS);
      return;
    }
    await this.onRunEnded(taskId, result.outcome, result.summary);
  }

  /** The cap hit today: wait for the next UTC midnight and tell the owner once. */
  private async deferForDailyLimit(
    meta: BotMeta,
    now: number,
  ): Promise<void> {
    const midnight = nextUtcMidnight(now);
    const firstHit = meta.nextWakeAt !== midnight;
    meta.nextWakeAt = midnight;
    this.store.writeMeta(meta);
    await this.ctx.storage.setAlarm(midnight);
    if (firstHit) {
      await this.notice(
        meta,
        `⏸ ${meta.name} 今日唤醒已达 ${DAILY_WAKE_LIMIT} 次，推迟到明天 00:00 UTC`,
      );
    }
  }

  /** Counts one failed run and re-arms with backoff, pausing at the limit. */
  private async armAfterFailure(
    meta: BotMeta,
    now: number,
    reason: string,
  ): Promise<void> {
    meta.consecutiveFailures += 1;
    if (meta.consecutiveFailures >= PAUSE_AFTER_FAILURES) {
      meta.status = "paused";
      meta.nextWakeAt = null;
      this.store.writeMeta(meta);
      await this.ctx.storage.deleteAlarm();
      await this.notice(
        meta,
        `⚠️ ${meta.name} 已暂停：连续 3 次失败（最近原因：${reason}）`,
      );
      return;
    }

    meta.nextWakeAt = clampWakeAt(
      now,
      Math.max(
        nextBase(meta, now),
        now + failureDelayMs(meta.consecutiveFailures),
      ),
    ).at;
    this.store.writeMeta(meta);
    if (meta.status === "active") {
      await this.ctx.storage.setAlarm(meta.nextWakeAt);
    }
  }

  private async notice(meta: BotMeta, text: string): Promise<void> {
    try {
      await this.butler().botNotice(meta.botId, text);
    } catch (error) {
      console.error("bot notice failed:", error);
    }
  }
}

/** The saved next wake when it is still ahead, otherwise the default cadence. */
function nextBase(meta: BotMeta, now: number): number {
  if (meta.nextWakeAt !== null && meta.nextWakeAt > now) {
    return meta.nextWakeAt;
  }
  return now + meta.defaultIntervalMs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
