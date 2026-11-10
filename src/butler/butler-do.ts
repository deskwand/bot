import { Agent, type Schedule } from "agents";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { assertModelWindowSwitch, ModelSwitchError } from "../llm/model-switch";
import { PiHarness, type PiModel, type PiOperationResult } from "agents/harness/pi";
import {
  createRegistry,
  Harness,
  LiveDoc,
  type LiveState,
  type Storage,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { BackupRpc } from "../admin/backup-rpc";
import { artifactNameFromKey } from "../artifact";
import { DEFER_MS, MaintenanceStore, type Lease } from "../admin/maintenance";
import type { BotDO, SpawnForBotResult } from "../bot/bot-do";
import type { BotChatInput } from "../bot/bot-chat-do";
import type { RunOutcome } from "../bot/bot-store";
import { HEAL_INTERVAL_MS } from "../bot/wake";
import { STALL_AFTER_MS } from "../task/stall";
import { ownerLocale, t, type Locale } from "../i18n";
import { phoneRules } from "../phone/style";
import { isInboxKey } from "../channels/inbox";
import { parseActiveChannel } from "../channels/route-identity";
import type { TextAction } from "../channels/text-action";
import type {
  DbSchema,
  DumpPage,
  DumpRow,
  TableSchema,
} from "../admin/sql-dump";
import { RuntimeConfigError, readRuntimeConfig } from "../runtime-config";
import {
  createModelsForEnv,
  defaultThinkingLevel,
  resolveModel,
} from "../llm/models";
import { PI_PROGRESS } from "../llm/pi-settings";
import {
  encodeAction,
  type Address,
  type AdmittedMessage,
  type Artifact,
  type ChannelMessageRef,
  type InboundFile,
  type OutboundMessage,
  type TaskEvent,
  type TaskEventBody,
} from "../protocol";
import {
  actionHint,
  artifactFailedText,
  approvalButtonLabel,
  approvalCardText,
  botNoticeText,
  cancelButton,
  decisionSuffix,
  errorNotice,
  fileTooLargeNotice,
  fileUnavailableNotice,
  imageUnavailableNotice,
  maintenanceRetryText,
  maintenanceText,
  noChannelText,
  retryHint,
  taskCancelledText,
  taskCompletedText,
  taskFailedText,
  taskMissingText,
  taskProgressText,
  taskStartedText,
  taskStartFailedText,
  taskStalledText,
  turnAckText,
  turnEmptyAnswerText,
  turnInterruptedText,
  turnStalledText,
  unsupportedMessageNotice,
  voiceUnavailableNotice,
} from "./owner-copy";
import {
  getClock,
  ProgressHeartbeat,
  ProgressThrottle,
  type ProgressPolicy,
} from "./notifier";
import {
  activityOf,
  planTurnCheck,
  retryDelayMs,
  signatureOf,
  TURN_CHECK_EVERY_MS,
  TURN_PARKED_GRACE_MS,
} from "./turn";
import { TurnStore, type TurnRow } from "./turn-store";
import {
  MemoryStore,
  renderMemorySection,
  renderOwnerProfile,
} from "./memory";
import { BotsRepo } from "./bots-repo";
import {
  LEDGER_RETENTION_MS,
  LedgerStore,
  renderLedgerPrefix,
  snippet,
} from "./ledger";
import { resolveBotAddress } from "./bot-address";
import {
  toUserInput,
  turnBlocker,
  unansweredText,
} from "./model-gate";
import { createBotTools } from "./bot-tools";
import { butlerSystemPrompt } from "./prompt";
import {
  InvalidCronError,
  isCronParseError,
  ScheduleStore,
} from "./schedules";
import { TasksRepo, taskLabel, type TaskRow } from "./tasks-repo";
import {
  resolveTextAction as resolveAgainstCandidates,
  type PendingApproval,
  type Resolution,
} from "./text-resolution";
import { createButlerTools, SpawnFailedError, type TaskControl } from "./tools";

type TaskEventRow = {
  seq: number;
  type: string;
  payload_json: string;
};

type ApprovalMessageRow = {
  approval_id: string;
  task_id: string;
  message_ref_json: string | null;
  text: string;
};

const PROGRESS_INTERVAL_MS = 3000;
const PROGRESS_HEARTBEAT_INTERVAL_MS = 180_000;
const PROGRESS_HEARTBEAT_FIRST_MS = 60_000;
const PROGRESS_DETAIL_MAX = 200;
const MESSAGE_MAX = 4096;
const BOT_HEAL_KEY = "bot_heal_at";
const TASK_HEAL_KEY = "task_heal_at";
const TASK_PROBE_FAILURES_PREFIX = "task_probe_failures:";

/** The part of a bot chat stub the Butler uses. */
type BotChatStub = {
  chat(input: BotChatInput): Promise<void>;
  destroy(): Promise<void>;
};

let botChatStubOverride:
  | ((botId: string) => { chat(input: BotChatInput): Promise<void> })
  | null = null;

/** Test-only bot chat stub override, mirroring `setBotButlerOverride`. */
export function setBotChatStubOverride(
  fn: ((botId: string) => { chat(input: BotChatInput): Promise<void> }) | null,
): void {
  botChatStubOverride = fn;
}

/** Enabled MCP services the butler can hand to tasks, without their tools. */
function enabledServices(env: Env): { name: string; description?: string }[] {
  try {
    return readRuntimeConfig(env).mcpServers
      .filter((server) => server.enabled !== false)
      .map(({ name, description }) => ({ name, description }));
  } catch (error) {
    if (error instanceof RuntimeConfigError) return [];
    throw error;
  }
}

/**
 * What an edit attempt achieved for a saved message reference.
 *
 * `unsupported` means the reference can never be edited (the channel has no
 * message ids, or another deployment owns it); `failed` is transient, so the
 * old message stays valid and a retry may still succeed.
 */
type EditOutcome = "edited" | "unsupported" | "failed";

/**
 * Control-plane object: the Butler agent lives here. It converses with the
 * owner, dispatches background tasks and keeps their index.
 */
export class ButlerDO extends Agent<Env> {
  readonly registry = createRegistry();

  readonly harness: PiHarness;

  private readonly db: SqlStorage;

  private readonly repo: TasksRepo;

  readonly ledger: LedgerStore;

  private readonly bots: BotsRepo;

  private readonly memory: MemoryStore;

  private readonly schedules: ScheduleStore;

  private readonly lease: MaintenanceStore;

  private readonly backup: BackupRpc;

  /** The address of the message being answered (source of spawned tasks). */
  private origin: Address | null = null;

  private readonly throttle = new ProgressThrottle(PROGRESS_INTERVAL_MS);

  private readonly heartbeat = new ProgressHeartbeat(
    PROGRESS_HEARTBEAT_INTERVAL_MS,
    PROGRESS_HEARTBEAT_FIRST_MS,
  );

  private readonly progressTimers = new Map<string, unknown>();

  /** Single-flight guard for reconciling pending approvals on this instance. */
  private reconcilePromise: Promise<void> | null = null;

  /** The disabled-selection notice is logged once per instance, not per cron. */
  private disabledScheduleLogged = false;

  private turnStore: TurnStore | null = null;

  /** Delivery in progress in this instance. */
  private readonly deliveringTurns = new Set<string>();

  /** One sweep at a time: `checkTurn` and the cron can overlap. */
  private sweeping = false;

  /** Single-flight guard for arming the next turn check. */
  private turnCheckArming: Promise<void> | null = null;

  /** Serializes "interrupt, then submit" so two messages cannot race it. */
  private admitting: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        chat_id TEXT,
        progress_message_id TEXT,
        progress_message_ref_json TEXT,
        summary TEXT,
        artifacts_json TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS task_events (
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (task_id, seq)
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS approval_messages (
        approval_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        message_ref_json TEXT
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );

    // Appended columns keep existing objects: no rebuild, no data loss.
    this.ensureColumn("tasks", "progress_message_ref_json", "TEXT");
    this.ensureColumn("approval_messages", "message_ref_json", "TEXT");
    this.ensureColumn("tasks", "bot_id", "TEXT");
    this.ensureColumn("tasks", "handle", "INTEGER");

    this.repo = new TasksRepo(this.db);
    this.ledger = new LedgerStore(this.db);
    this.bots = new BotsRepo(this.db);
    this.memory = new MemoryStore(this.db);
    this.schedules = new ScheduleStore(this.db);
    this.lease = new MaintenanceStore(this.db);
    this.backup = new BackupRpc(ctx, this.lease);

    // Installed once, at construction: Pi may re-run the harness factory after
    // a storage error, so registry changes must not depend on it.
    this.registry.install({
      name: "butler",
      tools: [
        ...createButlerTools({
          repo: this.repo,
          task: (id) => this.taskFor(id),
          spawn: (title, instructions, attachments) =>
            this.spawn(title, instructions, undefined, attachments),
          resolveAttachment: (key) => this.resolveAttachment(key),
          memory: this.memory,
          createSchedule: (cron, title, instructions) =>
            this.createSchedule(cron, title, instructions),
          listSchedules: () => this.schedules.list(),
          removeSchedule: (id) => this.removeSchedule(id),
        }),
        ...createBotTools({
          bots: this.bots,
          bot: (id) => this.botFor(id),
          botChat: (id) => this.botChatFor(id),
          task: (id) => this.taskFor(id),
        }),
      ],
      sections: [
        {
          key: "butler",
          render: () =>
            butlerSystemPrompt(
              ownerLocale(this.env),
              enabledServices(this.env),
              parseActiveChannel(this.env.ACTIVE_CHANNEL),
            ),
        },
        {
          key: "memory",
          render: () => renderMemorySection(this.memory.all()),
        },
        {
          key: "phone",
          tag: false,
          render: () =>
            phoneRules(ownerLocale(this.env), { conversational: true }),
        },
      ],
    });

    // The default is a getter: pi only evaluates it when it opens the session,
    // so a missing DESKWAND_CONFIG does not make this object unconstructable.
    // A failure leaves the session without a model until `ensureModel` runs.
    const butler = this;
    const defaults = {
      get model(): PiModel | undefined {
        try {
          const model = resolveModel(
            readRuntimeConfig(butler.env).models.butler,
            butler.env,
          );
          return model;
        } catch (error) {
          if (error instanceof RuntimeConfigError) return undefined;
          throw error;
        }
      },
    };

    this.harness = new PiHarness({
      harness: ({ storage, context, onWake }) =>
        Harness.open(
          storage,
          {
            models: createModelsForEnv(this.env),
            registry: this.registry,
            onWake,
            settings: {
              progress: PI_PROGRESS,
              followUpMode: "all",
              afterFailedRun: "continue",
            },
          },
          context,
        ),
      defaults,
    });

    // `Agent` already installed the lifecycle; adding to it is required.
    this.lifecycle.use(this.harness);
  }

  /**
   * Lease RPCs. The admin gateway holds the same lease on the Butler and the
   * Channel hub; alarms are the only thing an admin request cannot cancel, so
   * they check it here and defer instead of running cron callbacks.
   */
  async acquireMaintenance(
    op: Lease["op"],
    opId: string,
  ): Promise<Lease | "busy"> {
    return this.lease.acquire(op, opId);
  }

  async renewMaintenance(opId: string): Promise<boolean> {
    return this.lease.renew(opId);
  }

  async releaseMaintenance(opId: string): Promise<void> {
    this.lease.release(opId);
  }

  async maintenanceActive(): Promise<boolean> {
    return this.lease.current() !== null;
  }

  /** The tasks this Butler indexes, in creation order (backup discovery). */
  listTaskIds(): string[] {
    return this.db
      .exec<{ id: string }>(`SELECT id FROM tasks ORDER BY created_at`)
      .toArray()
      .map((row) => row.id);
  }

  /** The bots this Butler indexes (backup discovery and management). */
  listBotIds(): string[] {
    return this.bots.list().map((row) => row.id);
  }

  /**
   * Cron sweep: asks every bot to repair a lost or stale alarm. Throttled so
   * the minute cron does not fan out RPCs every minute. The throttle stamp is
   * written first, so one stuck bot cannot make the next cron rescan.
   */
  async healBots(): Promise<{ checked: number; healed: number } | null> {
    const now = getClock().now();
    const last = Number(this.schedules.getMeta(BOT_HEAL_KEY) ?? NaN);
    if (Number.isFinite(last) && now - last < HEAL_INTERVAL_MS) return null;
    this.schedules.setMeta(BOT_HEAL_KEY, String(now));

    const bots = this.bots.list();
    let healed = 0;
    for (const bot of bots) {
      try {
        if ((await this.botFor(bot.id).heal()) === "healed") healed += 1;
      } catch (error) {
        // One broken bot must not stop the rest of the sweep.
        console.error("bot heal failed:", bot.id, error);
      }
    }
    return { checked: bots.length, healed };
  }

  /**
   * Probes every running task from the cron. A probe that fails twice in a
   * row means the run is gone: the Task DO cannot report its own death, so
   * the failure is recorded here through the ordinary failed path.
   */
  async healTasks(): Promise<{
    checked: number;
    interrupted: number;
  } | null> {
    const now = getClock().now();
    const last = Number(this.schedules.getMeta(TASK_HEAL_KEY) ?? NaN);
    if (Number.isFinite(last) && now - last < STALL_AFTER_MS) return null;
    this.schedules.setMeta(TASK_HEAL_KEY, String(now));

    const running = this.repo
      .list({ active: true })
      .filter((row) => row.status === "running");
    let interrupted = 0;
    for (const row of running) {
      const failureKey = `${TASK_PROBE_FAILURES_PREFIX}${row.id}`;
      let probeFailed = false;
      try {
        const probed = await this.taskFor(row.id).liveness();
        // `liveness` flushes the outbox first, so a run that finished would
        // already have reported and flipped the row. A row still `running`
        // while the probe says otherwise is as dead as a thrown probe.
        probeFailed =
          probed.state !== "running" &&
          this.repo.get(row.id)?.status === "running";
        if (probeFailed) {
          console.error(
            `task probe failed: ${row.id} state=${probed.state}`,
          );
        }
      } catch (error) {
        // A deploy or a short network blip can fail one probe; only the
        // second consecutive failure is treated as a lost run.
        console.error("task probe failed:", row.id, error);
        probeFailed = true;
      }
      if (!probeFailed) {
        this.schedules.deleteMeta(failureKey);
        continue;
      }
      const failures = Number(this.schedules.getMeta(failureKey) ?? "0") + 1;
      if (failures < 2) {
        this.schedules.setMeta(failureKey, String(failures));
        continue;
      }
      this.schedules.deleteMeta(failureKey);
      await this.handleFailed(
        row.id,
        t(ownerLocale(this.env), "butler.task.interrupted"),
        false,
        now,
      );
      interrupted += 1;
    }
    return { checked: running.length, interrupted };
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
  }

  async restoreReset(): Promise<void> {
    this.backup.restoreReset();
  }

  override async alarm(): Promise<void> {
    if (this.lease.current() !== null) {
      await this.ctx.storage.setAlarm(Date.now() + DEFER_MS);
      return;
    }
    await super.alarm();
  }

  override async onStart(props?: object): Promise<void> {
    await super.onStart(props);
    // Do not block startup: the sweep talks to pi.
    this.ctx.waitUntil(this.resumeTurns());
  }

  /** Re-attach every undelivered turn, then keep one check armed. */
  async resumeTurns(): Promise<void> {
    if (this.lease.current() !== null) return;
    // Ordinary wakes have an empty ledger: skip opening pi for nothing. The
    // crash between `submit` and the row insert is left to the minute cron.
    if (this.turns().list().length === 0) return;
    try {
      await this.sweepTurns(getClock().now());
      await this.ensureTurnCheck();
    } catch (error) {
      console.error("butler turn resume failed:", error);
    }
  }

  /** Cron sweep: the backstop for a lost alarm or a lost `wait`. */
  async healTurns(): Promise<{ outstanding: number }> {
    if (this.lease.current() !== null) return { outstanding: 0 };
    this.turns().pruneAnswers(getClock().now() - 86_400_000);
    this.ledger.prune(getClock().now() - LEDGER_RETENTION_MS);
    await this.sweepTurns(getClock().now());
    const outstanding = this.turns().list().length;
    if (outstanding > 0) await this.ensureTurnCheck();
    return { outstanding };
  }

  /**
   * Creates the task row and starts its Task DO. Shared by the `spawn_task`
   * tool and by scheduled runs. Returns the new task id.
   */
  async spawn(
    title: string,
    instructions: string,
    origin: Address | null = this.origin,
    attachments: InboundFile[] = [],
  ): Promise<string> {
    const locale = ownerLocale(this.env);
    const id = this.repo.nextId();
    this.repo.insert({
      id,
      title,
      chatId: origin === null ? null : JSON.stringify(origin),
    });
    const row = this.repo.get(id);
    const label = row ? taskLabel(row) : id;

    // Send the start message before the run begins: the first progress event
    // can arrive while `start()` is still in flight, and it must edit this
    // message rather than create a second one. Task output always goes to the
    // selected channel, whichever channel the task was spawned from.
    const progressRef = await this.sendBestEffort({
      text: clampMessage(taskStartedText(locale, label, title)),
      buttons: [
        [
          {
            ...cancelButton(locale, label),
            data: encodeAction({ action: "cancel", taskId: id }),
          },
        ],
      ],
    });
    if (progressRef !== null) {
      this.repo.update(id, { progressMessageRef: progressRef });
    }

    try {
      await this.taskFor(id).start({
        taskId: id,
        title,
        instructions,
        ...(attachments.length === 0 ? {} : { attachments }),
      });
    } catch (error) {
      // Without a started Task DO the row would otherwise stay `queued`
      // forever and look like an active task.
      const message = errorText(error);
      this.repo.update(id, { status: "failed", summary: message });
      if (progressRef !== null) {
        await this.editBestEffort(progressRef, {
          text: clampMessage(taskStartFailedText(locale, label, title, message)),
        });
      }
      throw new SpawnFailedError(id, message);
    }

    return id;
  }

  /**
   * Resolves an inbox key to the file reference a task can receive. Anything
   * outside the inbox, or a missing object, is not an attachment.
   */
  async resolveAttachment(key: string): Promise<InboundFile | null> {
    if (!isInboxKey(key)) return null;
    const object = await this.env.ARTIFACTS.head(key);
    if (object === null) return null;
    return {
      name: artifactNameFromKey(key),
      key,
      mimeType:
        object.httpMetadata?.contentType ?? "application/octet-stream",
      size: object.size,
    };
  }

  /**
   * Dispatches one bot run. Unlike `spawn` this is silent: a bot wakes on its
   * own schedule, so a start/progress/completion message would only be noise.
   */
  async spawnForBot(
    botId: string,
    title: string,
    instructions: string,
    authorization?: string,
  ): Promise<SpawnForBotResult> {
    if (this.lease.current() !== null) {
      return {
        ok: false,
        reason: "maintenance",
        message: maintenanceText(ownerLocale(this.env)),
      };
    }

    const route = await this.channels().currentRoute();
    if (route.channel === null) {
      return {
        ok: false,
        reason: "channel_disabled",
        message: noChannelText(ownerLocale(this.env)),
      };
    }

    const id = this.repo.nextId();
    this.repo.insert({ id, title, chatId: null, botId });

    try {
      await this.taskFor(id).start({
        taskId: id,
        title,
        instructions,
        botId,
        ...(authorization === undefined ? {} : { authorization }),
      });
    } catch (error) {
      const message = errorText(error);
      this.repo.update(id, { status: "failed", summary: message });
      return { ok: false, reason: "failed", message };
    }

    return { ok: true, taskId: id };
  }

  /** Persists a schedule and registers its cron on the Agent lifecycle. */
  async createSchedule(
    cron: string,
    title: string,
    instructions: string,
  ): Promise<string> {
    const id = this.schedules.add(cron, instructions, title, null);

    try {
      const schedule = await this.schedule<{ scheduleId: string }>(
        cron,
        "runSchedule",
        { scheduleId: id },
      );
      this.schedules.setAgentScheduleId(id, schedule.id);
    } catch (error) {
      // Keep no row for an expression the scheduler refuses.
      this.schedules.remove(id);
      throw isCronParseError(error) ? new InvalidCronError(cron) : error;
    }

    return id;
  }

  async removeSchedule(id: string): Promise<boolean> {
    const row = this.schedules.get(id);
    if (!row) return false;
    if (row.agentScheduleId !== null) {
      await this.cancelSchedule(row.agentScheduleId);
    }
    return this.schedules.remove(id);
  }

  /** Cron callback registered through `Agent.schedule`. */
  async runSchedule(payload: { scheduleId: string }): Promise<void> {
    const row = this.schedules.get(payload.scheduleId);
    if (!row) return;

    // With a disabled selection (for example a typo in ACTIVE_CHANNEL) every
    // notification would be swallowed: do not burn model tokens on a run
    // nobody hears about.
    const route = await this.channels().currentRoute();
    if (route.channel === null) {
      if (!this.disabledScheduleLogged) {
        this.disabledScheduleLogged = true;
        console.error(
          `butler schedule ${row.id} skipped: channel selection disabled`,
        );
      }
      return;
    }

    try {
      await this.spawn(row.title, row.instructions, null);
    } catch (error) {
      // The task row was already marked failed; retrying the cron would only
      // create another task, so log and wait for the next occurrence.
      console.error(`butler schedule ${row.id} failed:`, error);
    }
  }

  /**
   * RPC entry for inbound channel messages. `Agent` reserves the name
   * `onMessage` for its hibernating-WebSocket handler (and hide it from RPC),
   * so the gateway's `onMessage` is mapped here in `src/index.ts`.
   */
  async handleMessage(evt: AdmittedMessage): Promise<void> {
    // A live lease pauses inbound work. The channel hub already rejects new
    // webhooks and polling, but an in-flight dispatch can still arrive.
    if (this.lease.current() !== null) {
      throw new Error("maintenance lease active");
    }
    try {
      await this.handleInboundMessage(evt);
    } catch (error) {
      console.error("butler message failed:", error);
      await this.sendErrorReply(
        error instanceof ModelSwitchError ? error.message : errorNotice(ownerLocale(this.env)),
      );
    }
  }

  /**
   * Display-only progress from a Task DO. Unlike `report` it is neither
   * sequenced nor stored: a lost update is harmless, and skipping the event
   * log saves the rows each durable event writes on both sides.
   */
  async reportTaskProgress(taskId: string, text: string): Promise<void> {
    // Display-only progress is dropped while the deployment is quiesced; the
    // Task outbox keeps the durable events for after the lease.
    if (this.lease.current() !== null) return;
    const row = this.repo.get(taskId);
    if (!row || row.botId !== null) return;
    await this.handleProgress(taskId, text, getClock().now());
  }

  /** The run status a BotDO watchdog polls. `null` means still in flight. */
  async botTaskOutcome(
    taskId: string,
  ): Promise<{ outcome: RunOutcome | null; summary: string }> {
    const row = this.repo.get(taskId);
    if (!row) {
      return {
        outcome: "cancelled",
        summary: taskMissingText(ownerLocale(this.env)),
      };
    }
    if (
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "cancelled"
    ) {
      return { outcome: row.status, summary: row.summary ?? "" };
    }
    return { outcome: null, summary: "" };
  }

  /** Sends a bot message as-is (the text already carries any prefix). */
  async botNotice(botId: string, text: string): Promise<void> {
    const ref = await this.sendBestEffort({ text: clampMessage(text) });
    if (ref === null) return;
    const bot = this.bots.get(botId);
    // The copy already names the bot, so the ledger line is the text itself.
    if (bot !== null) this.writeBotLedger(botId, snippet(text));
  }

  /** What the Butler knows about the owner, for a bot's wake context. */
  async ownerProfile(): Promise<string> {
    return renderOwnerProfile(this.memory.all());
  }

  /** Sends `notify_owner` output, prefixed with the bot's name. */
  async notifyFromBot(botId: string, text: string): Promise<boolean> {
    const bot = this.bots.get(botId);
    if (!bot) return false;
    const locale = ownerLocale(this.env);
    const ref = await this.sendBestEffort({
      text: clampMessage(botNoticeText(locale, bot.name, text)),
    });
    if (ref === null) return false;
    this.writeBotLedger(
      botId,
      t(locale, "phone.ledgerBotMessage", {
        name: bot.name,
        snippet: snippet(text),
      }),
    );
    return true;
  }

  /** Bookkeeping for a bot message the owner already received. */
  private writeBotLedger(botId: string, line: string): void {
    try {
      this.ledger.add("bot.message", botId, line, getClock().now());
    } catch (error) {
      console.error("butler ledger write failed:", error);
    }
  }

  async report(event: TaskEvent): Promise<void> {
    // Fail closed: throwing makes Outbox.flush keep delivered = 0 and retry
    // once the maintenance lease is gone. Acknowledging here would let the
    // TaskDO mark an event delivered while the Butler never stored it.
    if (this.lease.current() !== null) {
      throw new Error("maintenance lease active");
    }

    const now = getClock().now();

    // Events can arrive before the Butler has spawned/indexed the task.
    if (!this.repo.get(event.taskId)) {
      this.repo.insert({
        id: event.taskId,
        title: "",
        chatId: null,
        handle: false,
      });
    }

    const row = this.repo.get(event.taskId);
    if (!row) return;

    // Dedupe: a redelivered or older event is acknowledged and dropped.
    if (event.seq <= row.lastSeq) return;

    const { taskId, seq, ...body } = event;
    this.ctx.storage.transactionSync(() => {
      this.repo.update(taskId, { lastSeq: seq, updatedAt: now });
      this.db.exec(
        `INSERT INTO task_events (task_id, seq, type, payload_json)
         VALUES (?, ?, ?, ?)`,
        taskId,
        seq,
        body.type,
        JSON.stringify(body),
      );
    });

    switch (body.type) {
      case "started":
        // A retry keeps the task id, so a handle left over from the failed
        // run may have been taken by a newer task in the meantime.
        this.repo.ensureHandle(taskId);
        this.repo.update(taskId, { status: "running", updatedAt: now });
        break;
      case "progress":
        await this.handleProgress(taskId, body.text, now);
        break;
      case "approval_requested":
        await this.handleApprovalRequested(taskId, body);
        break;
      case "approval_resolved":
        await this.handleApprovalResolved(taskId, body.approvalId, body.decision);
        break;
      case "completed":
        this.schedules.deleteMeta(`${TASK_PROBE_FAILURES_PREFIX}${taskId}`);
        await this.handleCompleted(taskId, body.summary, body.artifacts, now);
        break;
      case "failed":
        this.schedules.deleteMeta(`${TASK_PROBE_FAILURES_PREFIX}${taskId}`);
        await this.handleFailed(taskId, body.reason, body.retryable, now);
        break;
      case "cancelled":
        this.schedules.deleteMeta(`${TASK_PROBE_FAILURES_PREFIX}${taskId}`);
        await this.handleCancelled(taskId, now);
        break;
      case "stalled":
        await this.handleStalled(taskId, body);
        break;
    }

    // A report is an activity point: re-present approvals this route owns.
    this.kickReconcile();
  }

  /**
   * Approvals the owner can still act on: a `requested` event without a
   * matching `resolved` one, for tasks that are active and owned by the owner.
   * Derived from the log so every Butler instance agrees without asking the
   * Task DOs.
   */
  pendingOwnerApprovals(): PendingApproval[] {
    const active = this.repo.listActiveOwner();
    const rows = this.db
      .exec<{ task_id: string; approval_id: string }>(
        `SELECT e.task_id AS task_id,
                json_extract(e.payload_json, '$.approvalId') AS approval_id
           FROM task_events e
          WHERE e.type = 'approval_requested'
            AND json_extract(e.payload_json, '$.approvalId') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM task_events r
               WHERE r.task_id = e.task_id
                 AND r.type = 'approval_resolved'
                 AND json_extract(r.payload_json, '$.approvalId')
                     = json_extract(e.payload_json, '$.approvalId')
            )
          ORDER BY e.seq ASC`,
      )
      .toArray();

    const byTask = new Map<string, string[]>();
    for (const row of rows) {
      const list = byTask.get(row.task_id) ?? [];
      // A re-delivered request event must not appear twice.
      if (!list.includes(row.approval_id)) list.push(row.approval_id);
      byTask.set(row.task_id, list);
    }

    const pending: PendingApproval[] = [];
    // Active order is handle order, so the candidate list reads #1, #2, …
    for (const task of active) {
      for (const approvalId of byTask.get(task.id) ?? []) {
        pending.push({
          taskId: task.id,
          handle: task.handle,
          approvalId,
          title: task.title,
        });
      }
    }
    return pending;
  }

  /**
   * Resolves a text command to a concrete action, a candidate list, or chat.
   * The legacy `t<n>` form already names the task and bypasses resolution.
   */
  async resolveTextAction(action: TextAction): Promise<Resolution> {
    const locale = ownerLocale(this.env);
    if (this.lease.current() !== null) {
      return { kind: "reply", text: maintenanceRetryText(locale) };
    }

    const target = action.target;
    if (target.kind === "taskId") {
      return action.approvalId === undefined
        ? {
            kind: "action",
            taskId: target.taskId,
            label: target.taskId,
          }
        : {
            kind: "action",
            taskId: target.taskId,
            label: target.taskId,
            approvalId: action.approvalId,
          };
    }

    return resolveAgainstCandidates(
      locale,
      { ...action, target },
      this.repo.listActiveOwner(),
      this.pendingOwnerApprovals(),
    );
  }

  /**
   * Re-presents live approvals after the selection changed or an earlier
   * presentation failed. The Worker's Cron calls this after channel keepalive.
   */
  async reconcileChannel(routeKey: string): Promise<void> {
    const route = await this.channels().currentRoute();
    if (route.channel === null || route.routeKey !== routeKey) return;
    await this.reconcileOnce(route.routeKey);
  }

  private reconcileOnce(routeKey: string): Promise<void> {
    this.reconcilePromise ??= this.reconcileNow(routeKey).finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  /** Fire-and-forget trigger used by inbound handling and task reports. */
  private kickReconcile(): void {
    this.ctx.waitUntil(
      (async () => {
        const route = await this.channels().currentRoute();
        if (route.channel === null) return;
        await this.reconcileOnce(route.routeKey);
      })().catch((error) => {
        console.error("butler reconcile failed:", error);
      }),
    );
  }

  private async reconcileNow(routeKey: string): Promise<void> {
    for (const task of this.repo.list({ active: true })) {
      let pending: {
        approvalId: string;
        tool: string;
        argsSummary: string;
        reason?: string;
      }[];
      try {
        pending = await this.taskFor(task.id).pendingApprovals();
      } catch (error) {
        console.error(
          `butler reconcile skipped task ${task.id}: ${errorText(error)}`,
        );
        continue;
      }

      for (const approval of pending) {
        if (this.presentedUnder(approval.approvalId, routeKey)) continue;
        await this.presentApproval(task.id, approval);
      }
    }
  }

  private presentedUnder(approvalId: string, routeKey: string): boolean {
    const approval = this.approvalMessage(approvalId);
    if (!approval) return false;
    return parseMessageRef(approval.message_ref_json)?.routeKey === routeKey;
  }

  /**
   * WeChat cannot edit a sent message, so every progress update there would
   * become a new chat message. Those tasks get a heartbeat instead. A missing
   * reference keeps the editing policy: the next send teaches us the channel.
   */
  private progressPolicy(row: TaskRow): ProgressPolicy {
    return row.progressMessageRef?.channel === "wechat"
      ? this.heartbeat
      : this.throttle;
  }

  private async handleProgress(
    taskId: string,
    detail: string,
    now: number,
  ): Promise<void> {
    const row = this.repo.get(taskId);
    if (!row || row.botId !== null) return;

    const text = clampMessage(
      taskProgressText(
        ownerLocale(this.env),
        taskLabel(row),
        row.title,
        clamp(detail, PROGRESS_DETAIL_MAX),
      ),
    );
    const allowed = this.progressPolicy(row).offer(taskId, text, now);
    if (allowed !== null) {
      await this.showProgress(taskId, allowed);
      return;
    }

    this.scheduleProgressFlush(taskId, now);
  }

  /**
   * A stalled run gets one standalone notice, so the progress message keeps
   * its reference and the terminal event still edits that same message. Bot
   * tasks never alert the owner, and a report that arrives after the task
   * ended must not resurrect it.
   */
  private async handleStalled(
    taskId: string,
    body: Extract<TaskEventBody, { type: "stalled" }>,
  ): Promise<void> {
    const row = this.repo.get(taskId);
    if (!row || row.status !== "running" || row.botId !== null) return;

    const locale = ownerLocale(this.env);
    await this.sendBestEffort({
      text: clampMessage(
        taskStalledText(
          locale,
          taskLabel(row),
          row.title,
          body.activity,
          body.idleMs,
        ),
      ),
      priority: "alert",
    });
  }

  private scheduleProgressFlush(taskId: string, now: number): void {
    if (this.progressTimers.has(taskId)) return;
    const dueAt = this.throttle.dueAt(taskId) ?? this.heartbeat.dueAt(taskId);
    if (dueAt === null) return;

    const handle = getClock().setTimeout(() => {
      this.progressTimers.delete(taskId);
      void this.flushProgress(taskId).catch((error) => {
        console.error("butler progress flush failed:", error);
      });
    }, dueAt - now + 1);
    this.progressTimers.set(taskId, handle);
  }

  /** Delivers buffered progress once the throttle interval has elapsed. */
  private async flushProgress(taskId: string): Promise<void> {
    const now = getClock().now();
    const due = [...this.throttle.takeDue(now), ...this.heartbeat.takeDue(now)];
    for (const item of due) {
      await this.showProgress(item.taskId, item.text);
    }

    // A timer can fire before the throttle window closes. Keep this task's
    // buffered update armed instead of stranding it until another event.
    const pending =
      this.throttle.dueAt(taskId) ?? this.heartbeat.dueAt(taskId);
    if (pending !== null) {
      this.scheduleProgressFlush(taskId, now);
    }
  }

  private cancelProgressTimer(taskId: string): void {
    const handle = this.progressTimers.get(taskId);
    if (handle === undefined) return;
    this.progressTimers.delete(taskId);
    getClock().clearTimeout(handle);
  }

  private async showProgress(taskId: string, text: string): Promise<void> {
    const row = this.repo.get(taskId);
    if (!row || isTerminal(row.status)) return;

    const message: OutboundMessage = {
      text: clampMessage(text),
      buttons: [
        [
          {
            ...cancelButton(ownerLocale(this.env), taskLabel(row)),
            data: encodeAction({ action: "cancel", taskId }),
          },
        ],
      ],
    };

    if (row.progressMessageRef !== null) {
      const previousRef = row.progressMessageRef;
      const outcome = await this.editBestEffort(previousRef, message);
      if (outcome === "edited") return;

      // The reference is useless to us either way. A transient failure keeps
      // the old message in place, so the next update re-sends instead of
      // duplicating this one; a reference that can never be edited (WeChat
      // has no message ids, an older deployment owns it) must not swallow the
      // update, so fall through and send it as a new message.
      this.repo.update(taskId, { progressMessageRef: null });
      if (outcome === "failed") return;

      // WeChat cannot edit messages, so every progress update would repeat the
      // cancel hint. Only its newly sent progress goes without buttons; the
      // start message already holds the only hint. Telegram keeps its buttons.
      if (previousRef.channel === "wechat") {
        const ref = await this.sendBestEffort({ text: message.text });
        if (ref !== null) {
          this.repo.update(taskId, { progressMessageRef: ref });
        }
        return;
      }
    }

    const ref = await this.sendBestEffort(message);
    if (ref !== null) {
      this.repo.update(taskId, { progressMessageRef: ref });
    }
  }

  private async showTerminal(taskId: string, text: string): Promise<void> {
    const row = this.repo.get(taskId);
    if (!row) return;

    // A terminal status is the answer the owner has been waiting for: the
    // WeChat queue must not evict it behind progress frames.
    const message: OutboundMessage = {
      text: clampMessage(text),
      priority: "critical",
    };
    if (row.progressMessageRef !== null) {
      const outcome = await this.editBestEffort(row.progressMessageRef, message);
      if (outcome === "edited") return;
      this.repo.update(taskId, { progressMessageRef: null });
    }

    const ref = await this.sendBestEffort(message);
    if (ref !== null) {
      this.repo.update(taskId, { progressMessageRef: ref });
    }
  }

  private async handleApprovalRequested(
    taskId: string,
    body: Extract<TaskEventBody, { type: "approval_requested" }>,
  ): Promise<void> {
    if (!this.repo.get(taskId)) return;
    await this.presentApproval(taskId, body);
  }

  /** Sends one approval request and records the reference that owns it. */
  private async presentApproval(
    taskId: string,
    approval: {
      approvalId: string;
      tool: string;
      argsSummary: string;
      reason?: string;
    },
  ): Promise<boolean> {
    const row = this.repo.get(taskId);
    if (!row) return false;

    const locale = ownerLocale(this.env);
    const bot = row.botId === null ? null : this.bots.get(row.botId);
    const prefix =
      row.botId === null
        ? ""
        : t(locale, "butler.notice.botTaskPrefix", {
            name: bot?.name ?? row.botId,
          });
    const label = taskLabel(row);
    const text = clampMessage(
      approvalCardText(locale, {
        prefix,
        label,
        tool: approval.tool,
        reason: approval.reason,
        argsSummary: approval.argsSummary,
      }),
    );
    // An owner task with exactly one live approval can take the implicit form.
    // Bot tasks never participate in owner resolution, so they always name the
    // internal id (an implicit 批准 must never reach a bot task).
    const implicit =
      row.botId === null && this.pendingOwnerApprovals().length === 1;
    const explicit = { taskId, approvalId: approval.approvalId };
    const ref = await this.sendBestEffort({
      text,
      priority: "critical",
      buttons: [
        [
          {
            label: approvalButtonLabel(locale, "approve"),
            data: encodeAction({
              action: "approve",
              taskId,
              approvalId: approval.approvalId,
            }),
            hint: actionHint(locale, "approve", implicit ? undefined : explicit),
          },
          {
            label: approvalButtonLabel(locale, "reject"),
            data: encodeAction({
              action: "reject",
              taskId,
              approvalId: approval.approvalId,
            }),
            hint: actionHint(locale, "reject", implicit ? undefined : explicit),
          },
        ],
      ],
    });
    // A failed send leaves no reference, so the next reconcile retries.
    if (ref === null) return false;

    this.db.exec(
      `INSERT INTO approval_messages
         (approval_id, task_id, message_id, text, message_ref_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(approval_id) DO UPDATE SET
         task_id = excluded.task_id,
         message_id = excluded.message_id,
         text = excluded.text,
         message_ref_json = excluded.message_ref_json`,
      approval.approvalId,
      taskId,
      ref.messageId ?? "",
      text,
      JSON.stringify(ref),
    );
    return true;
  }

  private async handleApprovalResolved(
    taskId: string,
    approvalId: string,
    decision: "approved" | "rejected" | "expired",
  ): Promise<void> {
    const approval = this.approvalMessage(approvalId);
    if (!approval || approval.task_id !== taskId) return;
    if (!this.repo.get(taskId)) return;

    const suffix = decisionSuffix(ownerLocale(this.env), decision);
    await this.editBestEffort(parseMessageRef(approval.message_ref_json), {
      text: `${clamp(approval.text, MESSAGE_MAX - suffix.length)}${suffix}`,
    });
  }

  private async handleCompleted(
    taskId: string,
    summary: string,
    artifacts: Artifact[],
    now: number,
  ): Promise<void> {
    // A redelivered completion can carry a higher seq than the first one, so
    // the event dedupe in `report` does not catch it. The task already
    // finished: repeating it would send the summary and artifacts twice.
    if (this.repo.get(taskId)?.status === "completed") return;

    this.throttle.drop(taskId);
    this.heartbeat.drop(taskId);
    this.cancelProgressTimer(taskId);
    this.repo.update(taskId, {
      status: "completed",
      summary,
      artifacts,
      updatedAt: now,
    });

    const row = this.repo.get(taskId);
    if (!row) return;
    if (row.botId !== null) {
      await this.forwardToBot(row.botId, taskId, "completed", summary);
      return;
    }
    const append = this.progressPolicy(row) === this.heartbeat;
    if (append) {
      // The single terminal message carries the status line, so the reference
      // that only existed to be edited is no longer needed.
      this.repo.update(taskId, { progressMessageRef: null });
    } else {
      await this.showTerminal(
        taskId,
        taskCompletedText(ownerLocale(this.env), taskLabel(row), row.title),
      );
    }
    await this.reportCompletion(row, summary, artifacts, append);
  }

  private async reportCompletion(
    row: TaskRow,
    summary: string,
    artifacts: Artifact[],
    append: boolean,
  ): Promise<void> {
    const locale = ownerLocale(this.env);
    const label = taskLabel(row);
    // A ledger write is bookkeeping: if it fails, the owner still gets the
    // task's own result below.
    try {
      this.ledger.add(
        "task.completed",
        row.id,
        t(locale, "phone.ledgerTaskCompleted", {
          label,
          title: row.title,
          snippet: snippet(summary),
        }),
        getClock().now(),
      );
    } catch (error) {
      console.error("butler ledger write failed:", error);
    }

    if (append) {
      await this.sendBestEffort({
        text: clampMessage(
          taskCompletedText(locale, label, row.title, summary || undefined),
        ),
        priority: "critical",
      });
    } else if (summary.length > 0) {
      // Telegram already edited the progress message to the status line, so
      // the result is the summary by itself.
      await this.sendBestEffort({ text: summary, priority: "critical" });
    }
    await this.deliverArtifacts(artifacts, locale);
  }

  /** 逐个下发产物；一个失败只影响它自己，主人会收到一句告知。 */
  private async deliverArtifacts(
    artifacts: Artifact[],
    locale: Locale,
  ): Promise<void> {
    for (const artifact of artifacts) {
      try {
        await this.channels().sendArtifact(artifact.key);
      } catch (error) {
        console.error("butler artifact send failed:", error);
        await this.sendBestEffort({
          text: artifactFailedText(
            locale,
            artifact.name,
            t(locale, "butler.notice.sendFailed"),
          ),
        });
      }
    }
  }

  private async handleFailed(
    taskId: string,
    reason: string,
    retryable: boolean,
    now: number,
  ): Promise<void> {
    this.throttle.drop(taskId);
    this.heartbeat.drop(taskId);
    this.cancelProgressTimer(taskId);
    this.repo.update(taskId, { status: "failed", updatedAt: now });

    const row = this.repo.get(taskId);
    if (!row) return;
    if (row.botId !== null) {
      // Keep the reason for the watchdog path (`botTaskOutcome`).
      this.repo.update(taskId, { summary: reason, updatedAt: now });
      await this.forwardToBot(row.botId, taskId, "failed", reason);
      return;
    }
    const locale = ownerLocale(this.env);
    const hint = retryHint(locale, retryable);
    const body = taskFailedText(locale, taskLabel(row), row.title, reason);
    await this.showTerminal(
      taskId,
      `${clamp(body, MESSAGE_MAX - hint.length)}${hint}`,
    );
  }

  private async handleCancelled(taskId: string, now: number): Promise<void> {
    this.throttle.drop(taskId);
    this.heartbeat.drop(taskId);
    this.cancelProgressTimer(taskId);
    this.repo.update(taskId, { status: "cancelled", updatedAt: now });

    const row = this.repo.get(taskId);
    if (!row) return;
    if (row.botId !== null) {
      await this.forwardToBot(row.botId, taskId, "cancelled", "");
      return;
    }
    await this.showTerminal(
      taskId,
      taskCancelledText(ownerLocale(this.env), taskLabel(row), row.title),
    );
  }

  private approvalMessage(approvalId: string): ApprovalMessageRow | undefined {
    return this.db
      .exec<ApprovalMessageRow>(
        `SELECT approval_id, task_id, message_ref_json, text
         FROM approval_messages WHERE approval_id = ?`,
        approvalId,
      )
      .toArray()[0];
  }

  private turns(): TurnStore {
    this.turnStore ??= new TurnStore(this.db);
    return this.turnStore;
  }

  /** Chat text for a settled turn; the caller sends it and clears the row. */
  private async turnResultText(result: PiOperationResult): Promise<string> {
    const locale = ownerLocale(this.env);
    if (result.status === "done") {
      const text = result.text?.trim() ?? "";
      return text.length > 0 ? text : turnEmptyAnswerText(locale);
    }
    if (result.reason === "model_error") {
      return unansweredText(
        result.reason,
        () => this.harness.session().messages(),
        locale,
      );
    }
    return turnInterruptedText(locale);
  }

  /** Sends the terminal message for one turn, then settles its ledger row. */
  private async sendTerminal(
    operationId: string,
    text: string,
    keep = false,
  ): Promise<void> {
    const store = this.turns();
    const row = store.get(operationId);
    if (
      row === undefined ||
      row.abandonedAt !== null ||
      this.deliveringTurns.has(operationId)
    ) {
      return;
    }
    const now = getClock().now();
    if (row.retryAt !== null && row.retryAt > now) return;
    // Another isolate may be mid-send; wait for it rather than send twice.
    if (row.deliveringAt !== null && now - row.deliveringAt < 60_000) return;

    this.deliveringTurns.add(operationId);
    store.delivering(operationId, now);
    try {
      // No `clampMessage` here: the Butler's answer went out unclamped before
      // this change, and truncating it would lose real content.
      const ref = await this.sendBestEffort({
        text,
        priority: "critical",
      });
      if (ref === null) {
        const attempts = store.fail(operationId);
        if (attempts >= 3) {
          console.error(
            "butler turn dropped after three failed sends:",
            operationId,
          );
          if (keep) store.abandon(operationId, now);
          else store.remove(operationId);
          return;
        }
        store.retryAt(operationId, now + retryDelayMs(attempts));
        return;
      }
      if (keep) store.abandon(operationId, now);
      else store.remove(operationId);
    } finally {
      this.deliveringTurns.delete(operationId);
    }
  }

  /** Stops a pi operation we are giving up on, so it leaves `pending()`. */
  private async abortTurn(operationId: string): Promise<void> {
    try {
      await this.harness.abort({ operationId });
    } catch (error) {
      console.warn("butler turn abort failed:", operationId, error);
    }
  }

  private async deliverResult(
    operationId: string,
    result: PiOperationResult,
  ): Promise<void> {
    // A superseded turn settles `unanswered` by design: it never had an answer
    // to deliver, so drop the row without a message. A `done` result settled
    // before the abort landed and must still reach the owner.
    const row = this.turns().get(operationId);
    if (row?.supersededAt != null && result.status === "unanswered") {
      this.turns().remove(operationId);
      return;
    }
    // Every operation a merged run answers gets the same answer id. The first
    // one to claim it delivers; the rest drop their ledger row silently.
    const answer = await this.answerIdOf(operationId);
    if (
      answer !== undefined &&
      !this.turns().claimAnswer(answer, operationId, getClock().now())
    ) {
      this.turns().remove(operationId);
      return;
    }
    // The bot answers the owner directly, so this turn's text is only the
    // model narrating the hand-off and must not be sent.
    if (result.status === "done" && (await this.handedToBot(operationId))) {
      this.turns().remove(operationId);
      return;
    }
    await this.sendTerminal(operationId, await this.turnResultText(result));
  }

  /**
   * True when this run handed the owner to a bot through a successful
   * `ask_bot`. The bot answers directly, so the butler's own answer is dropped.
   * It reads the same transcript as `supersedeIdleThinking`, so a turn resumed
   * after a restart is judged the same way.
   */
  private async handedToBot(operationId: string): Promise<boolean> {
    try {
      const record = await this.submissionOf(operationId);
      if (record?.type !== "input" || record.status !== "done") {
        return false;
      }
      // Bound the scan to this run's answer: a later turn's `ask_bot` must
      // not silence an older answer that a sweep is re-delivering.
      const entries = (await this.harness.messages()).filter(
        (entry) => entry.id > record.entry && entry.id <= record.answer,
      );
      const calls = new Set<string>();
      for (const entry of entries) {
        for (const message of entry.model ?? []) {
          if (message.role !== "assistant") continue;
          for (const content of message.content) {
            if (content.type === "toolCall" && content.name === "ask_bot") {
              calls.add(content.id);
            }
          }
        }
      }
      if (calls.size === 0) return false;
      for (const entry of entries) {
        for (const message of entry.model ?? []) {
          if (
            message.role === "toolResult" &&
            calls.has(message.toolCallId) &&
            !message.isError
          ) {
            return true;
          }
        }
      }
      return false;
    } catch (error) {
      // A duplicate answer beats a lost one: deliver unless proven handed off.
      console.error("butler ask_bot check failed:", error);
      return false;
    }
  }

  /**
   * A new owner message interrupts a turn that has not used a tool yet, so
   * the model re-answers with the new message in context instead of finishing
   * an answer to half the thought.
   */
  private async supersedeIdleThinking(eventId: string): Promise<void> {
    try {
      // A redelivery must not abort anything: pi rejects the duplicate, so
      // the interrupted turn would have no replacement. The ledger row is
      // gone once a turn is answered, so ask pi, which keeps the submission.
      if ((await this.submissionOf(eventId)) !== undefined) {
        return;
      }

      const pending = await this.harness.pending();
      const running = pending.filter(
        (operation) => operation.status === "running",
      );
      // An abort also withdraws everything queued behind the run, such as a
      // queued owner message, so only a run with nothing behind it is
      // interrupted.
      if (running.length === 0 || running.length !== pending.length) {
        return;
      }

      const entries: number[] = [];
      for (const operation of running) {
        const record = await this.submissionOf(operation.operationId);
        if (record?.entry !== undefined) entries.push(record.entry);
      }
      if (entries.length === 0) return;

      // Tools run only after their assistant entry committed, so an assistant
      // entry without a tool call means the turn had no side effect yet.
      const firstEntry = Math.min(...entries);
      const messages = await this.harness.messages();
      const usedTool = messages.some(
        (entry) =>
          entry.id > firstEntry &&
          entry.model?.some(
            (message) =>
              message.role === "assistant" &&
              message.content.some((content) => content.type === "toolCall"),
          ),
      );
      if (usedTool) return;

      const store = this.turns();
      const rows = running
        .map((operation) => store.get(operation.operationId))
        .filter((row): row is TurnRow => row !== undefined);
      const now = getClock().now();
      for (const row of rows) store.supersede(row.operationId, now);
      await this.abortTurn(running[0].operationId);
    } catch (error) {
      // Interrupting by mistake is worse than letting the turn finish.
      console.error("butler supersede check failed:", error);
    }
  }

  /**
   * The entry id pi settled this operation with, when it has one. `storage()`
   * is `@internal` on `PiHarness`, so it is read through `submissionOf`: the
   * answer id is shared by every operation merged into the run (see the
   * batching spec §8.5).
   */
  private async answerIdOf(operationId: string): Promise<string | undefined> {
    try {
      const record = await this.submissionOf(operationId);
      return record?.type === "input" && record.status === "done"
        ? String(record.answer)
        : undefined;
    } catch (error) {
      // A duplicate answer beats a lost one: deliver without the claim.
      console.error("butler answer id lookup failed:", error);
      return undefined;
    }
  }

  /**
   * One operation's submission record, as pi stored it. `storage()` is
   * `@internal` on `PiHarness`, so the cast is deliberate.
   */
  private async submissionOf(
    operationId: string,
  ): Promise<SubmissionRecord | undefined> {
    const pi = await this.harness.pi();
    const root = await pi.root(BACKGROUND_CONTEXT);
    const storage = await (
      this.harness as unknown as { storage(): Promise<Storage> }
    ).storage();
    return await storage.submissionByRequest(
      root.id,
      operationId,
      BACKGROUND_CONTEXT,
    );
  }

  /** One committed read of what pi is doing right now. */
  private async liveState(): Promise<LiveState | undefined> {
    const pi = await this.harness.pi();
    const root = await pi.root(BACKGROUND_CONTEXT);
    return await pi.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT);
  }

  /** Keep exactly one pending `checkTurn`, like `TaskDO.scheduleStallCheck`. */
  private async ensureTurnCheck(atMs?: number): Promise<void> {
    this.turnCheckArming ??= this.armTurnCheck(atMs).finally(() => {
      this.turnCheckArming = null;
    });
    await this.turnCheckArming;
  }

  private async armTurnCheck(atMs?: number): Promise<void> {
    try {
      const now = getClock().now();
      const pending = await this.listSchedules();
      // The scheduler stamps rows with wall-clock seconds, so compare against
      // the real clock rather than the injectable business clock.
      const realNow = Date.now();
      if (
        pending.some(
          (schedule) =>
            schedule.callback === "checkTurn" && schedule.time * 1000 > realNow,
        )
      ) {
        return;
      }
      const at = Math.max(atMs ?? now + TURN_CHECK_EVERY_MS, now + 1_000);
      await this.schedule((at - now) / 1000, "checkTurn");
    } catch (error) {
      console.error("butler turn check schedule failed:", error);
    }
  }

  /** One sweep: deliver settled turns, report stalls, decide the next look. */
  private async sweepTurns(now: number): Promise<number | null> {
    // `checkTurn`, `resumeTurns` and the minute cron can overlap; two sweeps
    // would both see an unsent stall notice and both send it.
    if (this.sweeping) return null;
    this.sweeping = true;
    try {
      return await this.runSweep(now);
    } finally {
      this.sweeping = false;
    }
  }

  private async runSweep(now: number): Promise<number | null> {
    const store = this.turns();
    const rows = store.list();
    const pending = await this.harness.pending();
    const byId = new Map(
      pending.map((operation) => [operation.operationId, operation]),
    );
    let rebuilt = 0;
    // Older releases submitted task reports as owner turns. Those leftovers
    // must neither be rebuilt here nor answered; abort them so they leave
    // `pending()` without sending anything.
    const LEGACY_TASK_REPORT_PREFIX = "task-completed:";
    for (const operation of pending) {
      if (operation.operationId.startsWith(LEGACY_TASK_REPORT_PREFIX)) {
        await this.abortTurn(operation.operationId);
        continue;
      }
      if (
        store.insertIfAbsent({
          operationId: operation.operationId,
          submittedAt: now,
        })
      ) {
        rebuilt += 1;
      }
    }
    if (rows.length === 0 && rebuilt === 0) return null;
    let nextAt: number | null = null;

    for (const row of rows) {
      const operation = byId.get(row.operationId);
      if (operation === undefined) {
        if (row.retryAt !== null && row.retryAt > now) continue;
        // Settled while nobody was waiting: resolve immediately and deliver.
        await this.deliverResult(
          row.operationId,
          await this.harness.wait(row.operationId),
        );
        continue;
      }
      if (operation.status === "parked") {
        if (row.retriedAt === null) {
          store.retried(row.operationId, now);
          await this.harness.retry();
          nextAt ??= now + 60_000;
          continue;
        }
        if (now - row.retriedAt >= TURN_PARKED_GRACE_MS) {
          // pi's crash-loop guard already stopped it and retry did not revive
          // it. Withdraw so it leaves `pending()`, then tell the owner.
          await this.abortTurn(row.operationId);
          await this.sendTerminal(
            row.operationId,
            turnInterruptedText(ownerLocale(this.env)),
            true,
          );
          continue;
        }
        store.start(row.operationId, now, true);
        nextAt ??= now + 60_000;
        continue;
      }
      if (operation.status !== "running") {
        // Queued: the stall clock must not run yet.
        store.start(row.operationId, now, true);
        nextAt ??= now + 60_000;
        continue;
      }

      store.start(row.operationId, now, false);
      const live = await this.liveState();
      store.observe(row.operationId, signatureOf(live), now);
      const current = store.get(row.operationId);
      if (current === undefined) continue;

      const locale = ownerLocale(this.env);
      const plan = planTurnCheck({
        now,
        phase: operation.status,
        activity: activityOf(live),
        activityAt: current.activityAt,
        noticeAt: current.noticeAt,
      });
      nextAt = Math.min(nextAt ?? Number.POSITIVE_INFINITY, plan.nextAt);
      if (plan.send?.kind === "stall") {
        const ref = await this.sendBestEffort({
          text: turnStalledText(locale, plan.send.activity, plan.send.idleMs),
          priority: "alert",
        });
        if (ref !== null) store.notice(row.operationId, now);
      }
    }

    return nextAt ??
      (store.list().length === 0 ? null : now + 60_000);
  }

  /** Scheduled callback: acknowledge, report a stall, and rescue lost waits. */
  async checkTurn(
    _payload?: unknown,
    schedule?: Schedule<unknown>,
  ): Promise<void> {
    if (this.lease.current() !== null) {
      await this.ensureTurnCheck(getClock().now() + 60_000);
      return;
    }
    const nextAt = await this.sweepTurns(getClock().now());
    if (nextAt === null) return;

    const now = getClock().now();
    const pending = await this.listSchedules();
    const realNow = Date.now();
    if (
      pending.some(
        (entry) =>
          entry.callback === "checkTurn" &&
          entry.id !== schedule?.id &&
          entry.time * 1000 > realNow,
      )
    ) {
      return;
    }
    await this.schedule(Math.max(nextAt - now, 1_000) / 1000, "checkTurn");
  }

  private async sendBestEffort(
    message: OutboundMessage,
  ): Promise<ChannelMessageRef | null> {
    try {
      return await this.channels().sendCurrent(message);
    } catch (error) {
      console.error("butler channel send failed:", error);
      return null;
    }
  }

  private async editBestEffort(
    ref: ChannelMessageRef | null,
    message: OutboundMessage,
  ): Promise<EditOutcome> {
    if (ref === null) return "unsupported";
    try {
      const edited = await this.channels().editCurrent(ref, message);
      if (edited) return "edited";
      console.error("butler channel edit failed: unsupported or stale reference");
      return "unsupported";
    } catch (error) {
      // Telegram answers 400 when an edit would not change the message. That
      // is success for us: the message already shows the wanted text. The
      // error crosses a DO boundary, so identify it by its text rather than
      // by class.
      if (
        errorText(error)
          .toLowerCase()
          .includes("message is not modified")
      ) {
        return "edited";
      }
      console.error("butler channel edit failed:", error);
      return "failed";
    }
  }

  /** Test-only seam: list the events recorded for a task, in seq order. */
  debugEvents(
    taskId: string,
  ): { seq: number; type: string; payload: TaskEventBody }[] {
    return this.db
      .exec<TaskEventRow>(
        `SELECT seq, type, payload_json FROM task_events
         WHERE task_id = ? ORDER BY seq ASC`,
        taskId,
      )
      .toArray()
      .map((row) => ({
        seq: row.seq,
        type: row.type,
        payload: JSON.parse(row.payload_json) as TaskEventBody,
      }));
  }

  private async handleInboundMessage(evt: AdmittedMessage): Promise<void> {
    const locale = ownerLocale(this.env);
    // Remember where a task spawned during this turn came from; task output
    // itself always goes to the selected channel.
    this.origin = addressOf(evt);

    if (!(await this.admissionHolds(evt))) return;

    const images = evt.images ?? [];
    const files = evt.files ?? [];
    if (evt.fileFailed) {
      await this.sendBestEffort({
        text:
          evt.fileFailed === "too_large"
            ? fileTooLargeNotice(locale)
            : fileUnavailableNotice(locale),
      });
      this.kickReconcile();
      return;
    }
    if (evt.imageFailed && images.length === 0 && files.length === 0) {
      await this.sendBestEffort({
        text: imageUnavailableNotice(locale),
      });
      this.kickReconcile();
      return;
    }
    if (evt.voiceFailed && evt.text === null && images.length === 0) {
      await this.sendBestEffort({
        text: voiceUnavailableNotice(locale),
      });
      this.kickReconcile();
      return;
    }
    if (evt.text === null && images.length === 0 && files.length === 0) {
      await this.sendBestEffort({ text: unsupportedMessageNotice(locale) });
      this.kickReconcile();
      return;
    }

    // Attachments stay with the Butler: `steer` cannot carry them, so a bot
    // run would never see the file.
    if (files.length === 0) {
      // Accepted risks: the bot path does not repeat the second
      // `admissionHolds` check below, so a route switch during the chat's
      // prompt refresh can still let one old-route message through. The fixed
      // empty/ambiguous replies are not deduped on redelivery.
      const address = resolveBotAddress(
        { text: evt.text, quotedText: evt.quotedText },
        this.bots.list(),
      );
      if (address.kind === "ambiguous") {
        const lines = address.matches
          .map((bot) => `${bot.id} ${bot.name}`)
          .join("\n");
        await this.sendBestEffort({
          text: t(locale, "butler.botChat.ambiguous", {
            name: address.name,
            lines,
          }),
        });
        this.kickReconcile();
        return;
      }
      if (address.kind === "bot") {
        if (address.text === "" && images.length === 0) {
          await this.sendBestEffort({
            text: t(locale, "butler.botChat.empty", {
              name: address.bot.name,
            }),
          });
          this.kickReconcile();
          return;
        }
        try {
          await this.botChatFor(address.bot.id).chat({
            botId: address.bot.id,
            text: address.text,
            images,
            eventId: evt.eventId,
          });
        } catch (error) {
          console.error(
            `butler bot chat ${address.bot.id} failed:`,
            error,
          );
          await this.sendBestEffort({
            text: t(locale, "butler.botChat.unavailable", {
              name: address.bot.name,
            }),
          });
        }
        this.kickReconcile();
        return;
      }
    }

    // Tests replace the model per message; in production this is a no-op after
    // the first message of an object instance.
    await this.ensureAgent();

    // Processing starts at `submit`; a stale input never reaches it.
    if (!(await this.admissionHolds(evt))) return;

    // Answer a missing key or an unavailable model here instead of letting pi
    // fail the run after the input was accepted.
    const blocked = turnBlocker(this.env, images.length > 0);
    if (blocked) {
      await this.sendBestEffort({ text: blocked });
      this.kickReconcile();
      return;
    }

    const operationId = evt.eventId;
    // The interruption sits right before `submit`: every earlier return has
    // already passed, so a blocked message cannot abort a turn it will not
    // replace.
    const admitted = this.admitting.then(async () => {
      await this.supersedeIdleThinking(operationId);
      // Read the unread ledger inside the chain: two owner messages that
      // arrive close together must not both carry the same rows.
      const ledger = this.ledger.pending();
      const prefix = renderLedgerPrefix(ledger.rows, ledger.omitted, locale);
      const text = prefix === "" ? evt.text : `${prefix}${evt.text ?? ""}`;
      const input = toUserInput(text, images, files);
      const receipt = await this.harness.submit(input, { operationId });
      if (receipt.accepted) this.ledger.consume(ledger.ids);
      return receipt;
    });
    this.admitting = admitted.catch(() => {});
    const receipt = await admitted;
    // Telegram redelivered an update we already accepted: never answer twice.
    if (!receipt.accepted) return;
    // A receipt is about the queue, not the model: send it as soon as pi
    // accepts the input, so a slow or failing model still tells the owner the
    // message arrived. It goes out before the row exists, so not even a sweep
    // that resolves the turn meanwhile can deliver the answer ahead of it.
    const receiptRef = await this.sendBestEffort({
      text: turnAckText(locale),
      priority: "normal",
    });
    // Only an accepted turn gets a row: a row always has a submission behind it.
    this.turns().insertIfAbsent({
      operationId,
      submittedAt: getClock().now(),
    });
    // `ack_at` is informational now: nothing gates on it.
    if (receiptRef !== null) this.turns().ack(operationId, getClock().now());

    await this.ensureTurnCheck();
    try {
      const result = await this.harness.wait(operationId);
      await this.deliverResult(operationId, result);
    } catch (error) {
      // Settle the ledger with one plain notice: the outer catch must not add
      // a second message for the same turn. Abort so a pending operation does
      // not come back as a rebuilt row, and keep the tombstone for the same
      // reason.
      console.error("butler turn failed:", error);
      await this.abortTurn(operationId);
      await this.sendTerminal(operationId, turnInterruptedText(locale), true);
    }
    this.kickReconcile();
  }

  private async admissionHolds(evt: AdmittedMessage): Promise<boolean> {
    if (
      await this.channels().isAdmissionCurrent(evt.channel, evt.routeKey)
    ) {
      return true;
    }
    console.warn("butler: dropped input from an old channel route");
    return false;
  }

  private async ensureAgent(): Promise<void> {
    const ref = readRuntimeConfig(this.env).models.butler;
    const model = resolveModel(ref, this.env);
    const models = createModelsForEnv(this.env);
    // Defaults apply only to new roots. Read the persisted model and level on
    // reopen.
    const conversation = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    const active = agent.model;
    if (active?.provider !== model.provider || active.modelId !== model.id) {
      assertModelWindowSwitch(
        models,
        active ? { provider: active.provider, id: active.modelId } : undefined,
        model,
        ownerLocale(this.env),
      );
      await this.harness.session().setModel(model);
    }
    // A level published after this root was created only reaches it here; an
    // unconfigured role falls back to the middle of what the model offers.
    const level =
      ref.thinkingLevel ??
      defaultThinkingLevel(models.getModel(ref.provider, ref.id));
    if (level !== undefined && level !== agent.thinkingLevel) {
      await conversation.configure({ thinkingLevel: level }, BACKGROUND_CONTEXT);
    }
  }

  private async sendErrorReply(text: string): Promise<void> {
    await this.sendBestEffort({ text });
  }

  /** System notice to the owner's current channel, best effort. */
  async systemNotice(text: string): Promise<void> {
    await this.sendBestEffort({ text: clampMessage(text) });
  }

  /** Adds a column to an object created by an older release. */
  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.db
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray();
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private channels() {
    return this.env.CHANNELS.get(this.env.CHANNELS.idFromName("channels"));
  }

  private taskFor(id: string): TaskControl {
    return this.env.TASK.get(this.env.TASK.idFromName(id));
  }

  private botFor(id: string): DurableObjectStub<BotDO> {
    return this.env.BOT.get(this.env.BOT.idFromName(id));
  }

  private botChatFor(id: string): BotChatStub {
    const override = botChatStubOverride;
    if (override !== null) {
      // The override stands in for `chat` only; deletion is covered by the
      // bot-tools tests, so `destroy` is a no-op here.
      return {
        chat: (input) => override(id).chat(input),
        destroy: async () => {},
      };
    }
    // A reused id must not inherit the previous bot's transcript, so the
    // object is named by the id and the index row's creation time.
    const row = this.bots.get(id);
    if (row === null) throw new Error(`bot ${id} is not in the index`);
    return this.env.BOT_CHAT.get(
      this.env.BOT_CHAT.idFromName(`${row.id}@${row.createdAt}`),
    );
  }

  /**
   * Hands a terminal event to the owning bot. A failed call is only logged:
   * the bot's watchdog asks `botTaskOutcome` later and records the run then.
   */
  private async forwardToBot(
    botId: string,
    taskId: string,
    outcome: RunOutcome,
    summary: string,
  ): Promise<void> {
    try {
      await this.botFor(botId).onRunEnded(taskId, outcome, summary);
    } catch (error) {
      console.error(`butler bot ${botId} outcome failed:`, error);
    }
  }
}

function parseMessageRef(json: string | null): ChannelMessageRef | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ChannelMessageRef;
  } catch {
    return null;
  }
}

function addressOf(evt: AdmittedMessage): Address {
  return { channel: evt.channel, conversationId: evt.chatId };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminal(status: TaskRow["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function clampMessage(text: string): string {
  return clamp(text, MESSAGE_MAX);
}
