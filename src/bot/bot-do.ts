import { DurableObject } from "cloudflare:workers";
import { BackupRpc } from "../admin/backup-rpc";
import { DEFER_MS } from "../admin/maintenance";
import type {
  DbSchema,
  DumpPage,
  DumpRow,
  TableSchema,
} from "../admin/sql-dump";
import { getClock } from "../butler/notifier";
import { ownerLocale } from "../i18n";
import { isQuotaExhaustedSummary } from "../llm/model-errors";
import {
  BotStore,
  type BotMeta,
  type RunOutcome,
  type RunRow,
} from "./bot-store";
import { RULES_DOC, checkDocWrite, type BotDoc } from "./docs";
import { buildBotAuthorization, buildBotInstructions } from "./instructions";
import {
  botDailyLimitText,
  botFinishedText,
  botPausedText,
  botRunTimeoutText,
} from "./owner-copy";
import {
  CHANNEL_DISABLED_RETRY_MS,
  DAILY_WAKE_LIMIT,
  MIN_WAKE_MS,
  PAUSE_AFTER_FAILURES,
  RUN_MAX_MS,
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
  rules?: string;
};

export type BotSnapshot = {
  meta: BotMeta;
  docs: BotDoc[];
  runs: RunRow[];
};

export type SpawnForBotResult =
  | { ok: true; taskId: string }
  | {
      ok: false;
      reason: "channel_disabled" | "failed" | "maintenance";
      message: string;
    };

/** The Butler RPCs a bot depends on. Structural so tests can inject a fake. */
export type BotButler = {
  spawnForBot(
    botId: string,
    title: string,
    instructions: string,
    authorization?: string,
  ): Promise<SpawnForBotResult>;
  botTaskOutcome(
    taskId: string,
  ): Promise<{ outcome: RunOutcome | null; summary: string }>;
  botNotice(botId: string, text: string): Promise<void>;
  ownerProfile(): Promise<string>;
  maintenanceActive(): Promise<boolean>;
};

/** The Task RPC a bot uses to cancel a run. */
export type BotTask = { cancel(): Promise<unknown> };

let butlerOverride: BotButler | null = null;

let taskOverride: ((taskId: string) => BotTask) | null = null;

/** Test-only Butler override, mirroring `setChannelOverride`. */
export function setBotButlerOverride(stub: BotButler | null): void {
  butlerOverride = stub;
}

/** Test-only Task override, mirroring `setBotButlerOverride`. */
export function setBotTaskOverride(
  fn: ((taskId: string) => BotTask) | null,
): void {
  taskOverride = fn;
}

/**
 * Long-lived identity for one autonomous bot: mission, documents, run log and
 * wake time. It never runs a model; every wake goes through the Butler, which
 * dispatches a TaskDO and reports the outcome back here.
 */
export class BotDO extends DurableObject<Env> {
  store: BotStore;

  private readonly backup: BackupRpc;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new BotStore(ctx.storage.sql);
    // Tables restore in name order, so `memories` is fully written before
    // `meta` gets its row. Migrating mid-restore would fold a partial table
    // into `记忆` and drop it, breaking the remaining restore pages.
    if (this.store.readMeta() !== null) {
      this.store.migrateLegacyMemories(getClock().now());
    }
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
    const rules = spec.rules?.trim();
    if (rules !== undefined && rules.length > 0) {
      this.store.putDoc(RULES_DOC, rules, getClock().now());
    }
    await this.ctx.storage.setAlarm(spec.firstWakeAt);
  }

  async snapshot(): Promise<BotSnapshot | null> {
    const meta = this.store.readMeta();
    if (meta === null) return null;
    return {
      meta,
      docs: this.store.readDocs(),
      runs: this.store.recentRuns(5),
    };
  }

  /** Writes or deletes one document after the shared name and size checks. */
  async writeDoc(
    name: string,
    content: string,
    options: { allowRules: boolean },
  ): Promise<{ ok: boolean; message: string }> {
    if (this.store.readMeta() === null) {
      return { ok: false, message: "机器人不存在" }; // i18n-ignore: model-facing
    }
    const check = checkDocWrite(
      this.store.readDocs(),
      name,
      content,
      options,
    );
    if (!check.ok) return { ok: false, message: check.message };
    if (check.content === null) {
      return this.store.deleteDoc(check.name)
        ? { ok: true, message: `已删除「${check.name}」` } // i18n-ignore: model-facing
        : { ok: false, message: `没有文档「${check.name}」` }; // i18n-ignore: model-facing
    }
    this.store.putDoc(check.name, check.content, getClock().now());
    return {
      ok: true,
      message: `已写入「${check.name}」（${check.used}/${check.limit} 字）`, // i18n-ignore: model-facing
    };
  }

  async searchRuns(keyword: string): Promise<RunRow[]> {
    if (this.store.readMeta() === null) return [];
    return this.store.searchRuns(keyword);
  }

  /**
   * Renames the bot. The Butler's index row is updated by the caller; this DO
   * only owns its own meta, so a rename never changes status, wake time or the
   * run in flight.
   */
  async rename(name: string): Promise<boolean> {
    const meta = this.store.readMeta();
    if (meta === null) return false;
    this.store.writeMeta({ ...meta, name });
    return true;
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
    if (meta === null) throw new Error("机器人不存在"); // i18n-ignore: model-facing

    const now = getClock().now();
    const requested = req.at ?? now + (req.afterMs ?? 0);
    const { at, clamped } = clampWakeAt(now, requested);
    meta.nextWakeAt = at;
    if (meta.status === "finished") {
      // Only the bot itself finishes. Scheduling again afterwards means it
      // took finish_bot for "end this run": the later call wins.
      meta.status = "active";
      meta.finishReason = null;
    }
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

  async wakeNow(): Promise<"scheduled" | "after_run" | "inactive"> {
    const meta = this.store.readMeta();
    if (meta === null || meta.status !== "active") return "inactive";
    const now = getClock().now();
    if (meta.currentTaskId !== null) {
      // The run in flight cannot be preempted: schedule right after it ends.
      meta.nextWakeAt = now + MIN_WAKE_MS;
      meta.manualWakeAt = meta.nextWakeAt;
      this.store.writeMeta(meta);
      return "after_run";
    }
    meta.nextWakeAt = now;
    meta.manualWakeAt = meta.nextWakeAt;
    this.store.writeMeta(meta);
    await this.ctx.storage.setAlarm(now);
    return "scheduled";
  }

  async pause(): Promise<void> {
    const meta = this.store.readMeta();
    if (meta === null) return;
    meta.status = "paused";
    meta.nextWakeAt = null;
    meta.manualWakeAt = null;
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
    meta.manualWakeAt = wakeNow ? meta.nextWakeAt : null;
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
    meta.finishReason = reason;
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
    if (!this.store.endRun(taskId, outcome, summary, now)) {
      // Already recorded, but a run that ended while its spawn was in flight
      // can still be current: release it so the bot is not stuck on it.
      if (meta.currentTaskId !== taskId) return;
      meta.currentTaskId = null;
      this.store.writeMeta(meta);
      if (meta.status !== "active") return;
      meta.nextWakeAt = clampWakeAt(now, nextBase(meta, now)).at;
      this.store.writeMeta(meta);
      await this.ctx.storage.setAlarm(meta.nextWakeAt);
      return;
    }
    // A late end from an older run must not move the current run's schedule.
    if (meta.currentTaskId !== null && meta.currentTaskId !== taskId) return;

    if (outcome === "completed") meta.consecutiveFailures = 0;
    if (meta.currentTaskId === taskId) meta.currentTaskId = null;

    if (
      outcome === "failed" &&
      meta.status === "active" &&
      !isQuotaExhaustedSummary(summary)
    ) {
      this.store.writeMeta(meta);
      await this.armAfterFailure(meta, now, summary);
      return;
    }

    this.store.writeMeta(meta);
    if (meta.status === "finished") {
      // Told only now, so a run that rescheduled after finish_bot stays quiet.
      await this.notice(
        meta,
        botFinishedText(ownerLocale(this.env), meta.name, meta.finishReason),
      );
      return;
    }
    if (meta.status !== "active") return;

    // Keep a manual wake manual when the run ended before the owner's requested
    // time and the bot did not reschedule: the minimum-interval clamp is not a
    // schedule change, so move the marker with the wake time.
    const requestedAt = meta.nextWakeAt;
    const keepManual =
      meta.manualWakeAt != null &&
      meta.manualWakeAt === requestedAt &&
      requestedAt !== null &&
      requestedAt > now;
    meta.nextWakeAt = clampWakeAt(now, nextBase(meta, now)).at;
    if (keepManual) meta.manualWakeAt = meta.nextWakeAt;
    this.store.writeMeta(meta);
    await this.ctx.storage.setAlarm(meta.nextWakeAt);
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // `deleteAll` also drops the SQL tables. Rebuild an empty store so late
    // RPCs see a missing meta row instead of failing on a missing table.
    this.store = new BotStore(this.ctx.storage.sql);
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

    // An alarm may fire early after a restore or a manually armed wake.
    if (meta.nextWakeAt !== null && meta.nextWakeAt > now + 60_000) {
      await this.ctx.storage.setAlarm(meta.nextWakeAt);
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

    let ownerProfile = "";
    try {
      ownerProfile = await this.butler().ownerProfile();
    } catch (error) {
      console.warn("bot owner profile failed:", error);
    }

    const instructions = buildBotInstructions({
      name: meta.name,
      mission: meta.mission,
      docs: this.store.readDocs(),
      ownerProfile,
      runs: this.store.recentRuns(3),
      steer: meta.pendingSteer,
      manualWake:
        meta.manualWakeAt != null && meta.manualWakeAt === meta.nextWakeAt,
    });
    const authorization = buildBotAuthorization({
      name: meta.name,
      mission: meta.mission,
      steer: meta.pendingSteer,
    });
    const consumed = meta.pendingSteer.length;

    let result: SpawnForBotResult;
    try {
      result = await this.butler().spawnForBot(
        meta.botId,
        meta.name,
        instructions,
        authorization,
      );
    } catch (error) {
      const current = this.store.readMeta();
      if (current !== null && current.status === "active") {
        await this.armAfterFailure(current, now, errorMessage(error));
      }
      return;
    }

    if (!result.ok) {
      if (result.reason === "maintenance") {
        await this.ctx.storage.setAlarm(now + DEFER_MS);
      } else if (result.reason === "channel_disabled") {
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
    if (current === null || current.status !== "active") {
      // The bot was paused, finished or deleted while the spawn was in flight.
      await this.cancelTask(result.taskId);
      if (current === null) return;
      // Keep the run so the cancelled outcome is recorded against it.
      current.wakesCount += 1;
      current.pendingSteer = current.pendingSteer.slice(consumed);
      current.manualWakeAt = null;
      this.store.insertRun(result.taskId, now);
      current.currentTaskId = result.taskId;
      this.store.writeMeta(current);
      return;
    }
    current.wakesCount += 1;
    current.pendingSteer = current.pendingSteer.slice(consumed);
    current.manualWakeAt = null;
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

  private task(taskId: string): BotTask {
    if (taskOverride !== null) return taskOverride(taskId);
    return this.env.TASK.get(
      this.env.TASK.idFromName(taskId),
    ) as unknown as BotTask;
  }

  private async cancelTask(taskId: string): Promise<void> {
    try {
      await this.task(taskId).cancel();
    } catch (error) {
      console.error("bot task cancel failed:", error);
    }
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
    const current = this.store.readMeta();
    if (current === null || current.currentTaskId !== taskId) return;
    if (result.outcome === null) {
      const startedAt = this.store.runStartedAt(taskId);
      if (startedAt !== null && now - startedAt > RUN_MAX_MS) {
        await this.cancelTask(taskId);
        await this.onRunEnded(
          taskId,
          "failed",
          botRunTimeoutText(ownerLocale(this.env)),
        );
        return;
      }
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
        botDailyLimitText(ownerLocale(this.env), meta.name, DAILY_WAKE_LIMIT),
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
        botPausedText(
          ownerLocale(this.env),
          meta.name,
          PAUSE_AFTER_FAILURES,
          reason,
        ),
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
