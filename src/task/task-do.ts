import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
import { httpRequestTool, safeRequestUrl } from "../tools/http-request";
import { getArtifactTool, safeArtifactRef } from "../tools/get-artifact";
import { exchangeExtension } from "../exchange/install";
import { mailExtension } from "../mail/install";
import { nowTool } from "../tools/now";
import { Agent, type Schedule } from "agents";
import { PiHarness } from "agents/harness/pi";
import { contentText, Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  GenerationTask,
  Harness,
  hook,
  ToolTask,
  type ReportInfo,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { BackupRpc } from "../admin/backup-rpc";
import { DEFER_MS } from "../admin/maintenance";
import { parseActiveChannel } from "../channels/route-identity";
import type {
  DbSchema,
  DumpPage,
  DumpRow,
  TableSchema,
} from "../admin/sql-dump";
import { createBotTaskTools } from "../bot/bot-tools";
import { discoverSkills, type SkillCatalog } from "../skills/catalog";
import { skillSystemPrompt } from "../skills/prompt";
import { ownerLocale, t } from "../i18n";
import { effectiveModelRef } from "../life/diet";
import type { Meter } from "../life/meter";
import { RuntimeConfigError, readRuntimeConfig } from "../runtime-config";
import {
  lastModelError,
  modelUnavailableShortText,
  userTextForModelError,
} from "../llm/model-errors";
import { oneShotOptions } from "../llm/one-shot";
import {
  createModelsForEnv,
  defaultThinkingLevel,
  modelReadiness,
  resolveModel,
} from "../llm/models";
import { PI_PROGRESS } from "../llm/pi-settings";
import type {
  ActionEvent,
  Artifact,
  TaskEvent,
  TaskEventBody,
  TaskSpec,
} from "../protocol";
import { saveArtifactTool } from "../tools/artifacts";
import {
  MAX_ARTIFACT_BYTES,
  artifactKeySegments,
  artifactNameFromKey,
} from "../artifact";
import {
  loadMcpTools,
  mcpConnector,
  mcpExtension,
  type McpGates,
} from "../tools/mcp";
import { documentConverterFromAi } from "../tools/file-content";
import { createR2WorkspaceEnv } from "../env/r2-env";
import { webFetchTool } from "../tools/web-fetch";
import { webSearchTool } from "../tools/web-search";
import { clearWorkspace, workspaceTools } from "../tools/workspace";
import { withProgress } from "../tools/wrap";
import {
  ApprovalGate,
  AutoGate,
  ReviewedGate,
  type ApprovalGateLike,
} from "./approvals";
import {
  cancelBlockedText,
  cancelNotStartedText,
  cancelOkText,
  missingApprovalIdText,
  parkedTaskText,
  progressArtifactText,
  progressDownloadText,
  progressReadText,
  progressSaveText,
  progressSearchText,
  progressTimeText,
  retryBlockedText,
  retryNotRetryableText,
  retryNotStartedText,
  retryOkText,
  skillsUnavailableText,
  steerBlockedText,
  steerNotStartedText,
  steerOkText,
  taskIncompleteText,
} from "./owner-copy";
import { Outbox } from "./outbox";
import { reviewAction, type ReviewComplete } from "./review";
import { taskSystemPrompt } from "./prompt";
import { taskApprovalMode, taskGates } from "./gates";
import { STALL_AFTER_MS, StallWatch, type TaskActivity } from "./stall";

export type TaskState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

type ControlResult = { ok: boolean; message: string };

/** How long `cancel()` waits for pi to become idle before returning anyway. */
const ABORT_TIMEOUT_MS = 10_000;

const FinishTask = Type.Object({
  summary: Type.String(),
  artifacts: Type.Optional(
    Type.Array(Type.Object({ key: Type.String() })),
  ),
});

/**
 * Drops pi's non-unique secondary indexes after its migrations ran. Every
 * index update bills as an extra SQLite row written, and pi upserts its task
 * records many times per model step. A Task DO holds one short task, so its
 * pi tables stay tiny and full scans cost next to nothing. Constraint indexes
 * (no `sql`, or UNIQUE) are kept. Idempotent: pi may reopen the harness.
 */
function dropPiSecondaryIndexes(sql: SqlStorage): void {
  const names = sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name LIKE 'pi\\_%' ESCAPE '\\'
         AND sql IS NOT NULL AND sql NOT LIKE 'CREATE UNIQUE%'`,
    )
    .toArray()
    .map((row) => row.name);
  for (const name of names) {
    sql.exec(`DROP INDEX IF EXISTS "${name}"`);
  }
}

/**
 * Execution-plane object: one instance per task, hosting a Pi sub-agent.
 * It never talks to a channel; everything is reported to the Butler through
 * the durable `Outbox`.
 */
export class TaskDO extends Agent<Env> {
  readonly registry = createRegistry();

  readonly harness: PiHarness;

  /** Every model call in this object reports its usage to the life ledger. */
  private get meter(): Meter {
    return {
      source: () =>
        this.spec?.botId !== undefined
          ? `bot:${this.spec.botId}`
          : `task:${this.currentTaskId() ?? "unknown"}`,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    };
  }

  readonly approvals: ApprovalGate;

  readonly reviewedGate: ReviewedGate;

  /** Gate for `http_request` writes, chosen by the approval mode. */
  private readonly writeGate: ApprovalGateLike;

  /** Gates for the MCP tool modes, chosen by the approval mode. */
  private readonly mcpGates: McpGates;

  /** Resolves once MCP tools were loaded and installed on this instance. */
  private mcpTools: Promise<void> | undefined;

  /** Resolves once this bot run installed its write-back tools. */
  private botTools: Promise<void> | undefined;

  /** Resolves once the read-only mail tools were considered on this instance. */
  private mailTools: Promise<void> | undefined;
  /** Resolves once the read-only exchange tools were considered on this instance. */
  private exchangeTools: Promise<void> | undefined;

  private readonly db: SqlStorage;

  private readonly backup: BackupRpc;

  private spec: TaskSpec | null;

  private outbox: Outbox | undefined;

  /**
   * Tool calls currently running, in start order (`call.id` → tool name).
   * In memory only: after an eviction the last activity written to storage is
   * still the best available answer.
   */
  private readonly runningTools = new Map<string, string>();

  /** Runs currently attached to this instance through `watchRun`. */
  private watchers = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;
    // Task objects have no maintenance lease of their own; the Butler holds it.
    this.backup = new BackupRpc(ctx, null);

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
      )`,
    );

    const storedSpec = this.readMeta("spec");
    this.spec = storedSpec ? (JSON.parse(storedSpec) as TaskSpec) : null;

    this.approvals = new ApprovalGate(
      this.db,
      (body) => {
        // An approval round-trip is a wait, not a stall; keep its activity
        // fresh so the timeout is measured from the request or the decision.
        if (
          body.type === "approval_requested" ||
          body.type === "approval_resolved"
        ) {
          this.touchActivity();
        }
        return this.emitProgress(body);
      },
      undefined,
      () => ownerLocale(this.env),
    );
    this.reviewedGate = new ReviewedGate(
      this.approvals,
      this.db,
      (tool, args, description, signal) =>
        reviewAction(
          {
            authorization:
              this.spec?.authorization ??
              (this.spec?.botId !== undefined
                ? ""
                : this.spec?.instructions) ??
              "",
            tool,
            toolDescription: description,
            args,
          },
          this.completeReview,
          signal,
          ownerLocale(this.env),
        ),
      (text) => this.emitProgress({ type: "progress", text }),
      () => ownerLocale(this.env),
    );

    const mode = taskApprovalMode(() => readRuntimeConfig(this.env));
    const gates = taskGates(mode, {
      approval: this.approvals,
      reviewed: this.reviewedGate,
      auto: new AutoGate(() => ownerLocale(this.env)),
    });
    this.writeGate = gates.write;
    this.mcpGates = gates.mcp;

    const finishTask: ToolRegistration<typeof FinishTask> = {
      name: "finish_task",
      description: `Finish the task with a concise summary and its artifacts. Required to deliver results.\n${t(ownerLocale(this.env), "phone.toolHint")}`,
      parameters: FinishTask,
      callers: ["model"],
      // Has side effects (reports completion); must not replay after a restart.
      execute: async ({ summary, artifacts }) => {
        const resolved = await this.resolveArtifacts(artifacts ?? []);
        if (!Array.isArray(resolved)) {
          return {
            output: [{ type: "text", text: resolved.error }],
            isError: true,
          };
        }
        await this.finish(summary, resolved);
        return { output: [{ type: "text", text: "Task finished." }] };
      },
    };

    // Installed once, at construction: Pi may re-run the harness factory after
    // a storage error, so registry changes must not depend on it.
    this.registry.install({
      name: "task",
      tools: [finishTask],
      hooks: [
        hook(ToolTask, {
          beforeTool: (call) => {
            this.onToolStart(call);
            return undefined;
          },
          afterTool: (call) => {
            this.onToolEnd(call);
            return undefined;
          },
        }),
        hook(GenerationTask, {
          afterResponse: () => {
            this.onModelResponse();
          },
        }),
      ],
      sections: [
        {
          key: "task",
          render: () =>
            this.spec
              ? taskSystemPrompt(
                  ownerLocale(this.env),
                  this.spec,
                  parseActiveChannel(this.env.ACTIVE_CHANNEL),
                )
              : undefined,
        },
        {
          key: "skills",
          render: () => {
            const raw = this.readMeta("skills_catalog");
            if (raw === undefined || raw === "pending") return undefined;
            try {
              return skillSystemPrompt(JSON.parse(raw) as SkillCatalog);
            } catch (error) {
              // A corrupt row must not wedge every later prompt.
              console.error("Stored skill catalog is unreadable", error);
              return undefined;
            }
          },
        },
      ],
    });

    // One converter shared by every file-reading tool in this task.
    const convert = documentConverterFromAi(this.env.AI);
    const emitProgress = (body: TaskEventBody) => this.emitProgress(body);
    this.registry.install({
      name: "execution",
      tools: [
        withProgress(
          webSearchTool(this.env),
          emitProgress,
          (args) => progressSearchText(ownerLocale(this.env), args.query),
        ),
        withProgress(
          getArtifactTool(this.env.ARTIFACTS, this.env.PUBLIC_BASE_URL, {
            taskId: () => this.currentTaskId() ?? "",
            attachments: () => (this.spec?.attachments ?? []).map((file) => file.key),
            convert,
          }),
          emitProgress,
          (args) => {
            const locale = ownerLocale(this.env);
            return progressArtifactText(
              locale,
              safeArtifactRef(args.ref, t(locale, "task.invalidUrl")),
            );
          },
        ),
        withProgress(
          httpRequestTool(this.writeGate),
          emitProgress,
          (args) => {
            const locale = ownerLocale(this.env);
            return `${args.method ?? "GET"} ${safeRequestUrl(
              args.url,
              t(locale, "task.invalidUrl"),
            )}`;
          },
        ),
        withProgress(
          nowTool(),
          emitProgress,
          () => progressTimeText(ownerLocale(this.env)),
        ),
        withProgress(
          webFetchTool(fetch, convert),
          emitProgress,
          (args) => progressReadText(ownerLocale(this.env), args.url),
        ),
        withProgress(
          saveArtifactTool(
            this.env.ARTIFACTS,
            () => this.currentTaskId() ?? "",
            () => this.assertNoMaintenance(),
          ),
          emitProgress,
          (args) => {
            const locale = ownerLocale(this.env);
            return args.url !== undefined
              ? progressDownloadText(
                  locale,
                  safeRequestUrl(args.url, t(locale, "task.invalidUrl")),
                )
              : progressSaveText(locale, args.filename ?? "");
          },
        ),
      ],
    });

    // Drafts live in `work/<taskId>/` in R2; the harness builds the environment
    // per tool call so a restarted sandbox never keeps a stale task id.
    this.registry.install({
      name: "workspace",
      tools: workspaceTools(
        this.env.ARTIFACTS,
        () => this.currentTaskId() ?? "",
      ),
    });

    // Model selection happens in `start` once the spec is available. Keeping
    // the constructor config-free lets alarms and control RPCs run without a
    // readable DESKWAND_CONFIG.
    this.harness = new PiHarness({
      harness: async ({ storage, context, onWake }) => {
        const harness = await Harness.open(
          storage,
          {
            models: createModelsForEnv(this.env, this.meter),
            registry: this.registry,
            onWake,
            settings: { progress: PI_PROGRESS },
            env: () => {
              const id = this.currentTaskId();
              return id ? createR2WorkspaceEnv(this.env.ARTIFACTS, id) : undefined;
            },
            onReport: (error, info) => {
              this.ctx.waitUntil(this.handleReport(error, info));
            },
          },
          context,
        );
        dropPiSecondaryIndexes(this.db);
        return harness;
      },
    });

    // `Agent` already installed the lifecycle; adding to it is required.
    this.lifecycle.use(this.harness);
  }

  override async onStart(props?: object): Promise<void> {
    // The admin restore RPC enters this object before dispatching the handler.
    // Defer every piece of startup business work while the Butler holds the
    // maintenance lease; the alarm below retries it after the lease is gone.
    if (await this.deferStartupIfMaintenance()) return;
    await this.runStartup(props);
  }

  private async runStartup(props?: object): Promise<void> {
    // Clear the flag before flushing: flushOutbox sets it again only if the
    // lease came back. Checking the old value here would skip the rest of
    // startup on the very alarm that resumed it.
    this.setMeta("startup_deferred", "0");
    await super.onStart(props);
    await this.flushOutbox();
    if (this.readMeta("startup_deferred") === "1") return;

    const state = this.readMeta("state");
    if (state === "queued" || state === "running") {
      await this.ensureMcpTools();
      await this.ensureBotTools();
      await this.ensureMailTools();
      await this.ensureExchangeTools();
    }

    // `wait` reads storage, so this survives restarts: re-attach to a run
    // that was still going when the object was evicted.
    if (state === "running") {
      if (this.hasCompletedEvent()) {
        // Crashed after recording `completed` but before storing the state.
        this.setMeta("state", "completed");
      } else {
        const operationId = this.readMeta("operation_id");
        if (operationId) this.ctx.waitUntil(this.watchRun(operationId));
        // A re-attached run must keep its stall watch; no bot run is watched.
        if (this.spec?.botId === undefined) {
          await this.armStallCheckFromActivity();
        }
      }
    }
  }

  override async onAlarm(): Promise<void> {
    await super.onAlarm();
    // The alarm override resumes deferred startup after it clears the lease.
    if (this.readMeta("startup_deferred") === "1") return;
    await this.flushOutbox();
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

  /** A live admin lease defers every alarm, including outbox retries. */
  override async alarm(): Promise<void> {
    let maintenanceActive: boolean;
    try {
      maintenanceActive = await this.butlerMaintenanceActive();
    } catch {
      // Fail closed: an unknown lease state must not run a task or schedule.
      // Keep retrying so the alarm fires again once the Butler answers.
      await this.ctx.storage.setAlarm(Date.now() + DEFER_MS);
      return;
    }

    if (maintenanceActive) {
      await this.ctx.storage.setAlarm(Date.now() + DEFER_MS);
      return;
    }
    await super.alarm();

    // Startup was skipped while the lease was live. Resume it now, after the
    // alarm path itself proved the lease is gone.
    if (this.readMeta("startup_deferred") === "1") {
      if (await this.deferStartupIfMaintenance()) return;
      await this.runStartup();
    }
  }

  async start(spec: TaskSpec): Promise<void> {
    await this.flushOutbox();
    // One task per instance. A `queued` state means a previous start did not
    // finish (submit throws or the object was evicted): retry it. The
    // operation id is deterministic, so resubmitting is idempotent in Pi.
    const storedSpec = this.readMeta("spec");
    const storedState = this.readMeta("state");
    if (
      storedSpec !== undefined &&
      storedState !== undefined &&
      storedState !== "queued"
    ) {
      return;
    }
    this.setMeta("state", "queued");
    if (this.readMeta("spec") === undefined) {
      this.spec = spec;
      // The catalog marker goes in the same transaction as the spec, so a new
      // task is never mistaken for one started before skills existed.
      this.ctx.storage.transactionSync(() => {
        this.setMeta("task_id", spec.taskId);
        this.setMeta("title", spec.title);
        this.setMeta("spec", JSON.stringify(spec));
        this.setMeta("skills_catalog", "pending");
      });
    }

    const effective = this.spec ?? spec;
    const operationId = `task:${effective.taskId}`;
    this.setMeta("operation_id", operationId);

    const outbox = this.outboxFor(effective.taskId);

    // The harness defaults are built in the constructor, before a fresh DO
    // knows its spec, so the model is chosen per session here. A resumed task
    // already has a root the defaults never reached, but it also already has
    // the level applied below, since only the first start gets here.
    const role = readRuntimeConfig(this.env).models.task;
    const configured = effective.model ?? role;
    const models = createModelsForEnv(this.env, this.meter);
    const selected = await effectiveModelRef(
      this.env,
      models,
      "task",
      configured,
    );
    await this.harness.session().setModel(resolveModel(selected, this.env));
    // The role's own level stays the owner's stated intent for its model; a
    // substituted model uses its own default instead.
    const substituted =
      selected.provider !== configured.provider ||
      selected.id !== configured.id;
    const level =
      selected.thinkingLevel ??
      (substituted ? undefined : role.thinkingLevel) ??
      defaultThinkingLevel(models.getModel(selected.provider, selected.id));
    if (level !== undefined) {
      const conversation = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
      if ((await conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel !== level) {
        await conversation.configure({ thinkingLevel: level }, BACKGROUND_CONTEXT);
      }
    }

    // Durable before submit and only once: retries and very fast runs must not
    // let `completed` get a lower seq than `started`.
    if (!this.hasEvent("started")) {
      await outbox.emit({ type: "started" });
    }

    // A cancel can land while this start is setting up.
    if (this.readMeta("state") === "cancelled") return;

    // Refuse before any tool setup or model work: a missing key or an
    // unavailable model is a permanent failure, not a retryable one.
    const notReady = modelReadiness(this.env, models, selected);
    if (notReady) {
      await this.failWith(notReady, false);
      return;
    }

    // The catalog is fixed for this task: the model gets the snapshot stored
    // here, while each entry body is read live when the model opens it.
    if (this.readMeta("skills_catalog") === "pending") {
      try {
        const catalog = await discoverSkills(this.env.ARTIFACTS);
        if (this.readMeta("state") === "cancelled") return;
        this.setMeta("skills_catalog", JSON.stringify(catalog));
      } catch (error) {
        console.error("Skill discovery failed", error);
        await this.failWith(
          skillsUnavailableText(ownerLocale(this.env)),
          false,
        );
        return;
      }
    }
    if (this.readMeta("state") === "cancelled") return;

    // MCP tools are loaded outside the harness factory so a restart never
    // rebuilds them mid-run; install them before the model can ask for one.
    await this.ensureMcpTools();
    await this.ensureBotTools();
    await this.ensureMailTools();
    await this.ensureExchangeTools();

    await this.harness.submit(effective.instructions, { operationId });

    // …or while the submit is in flight: stop the run it just accepted.
    if (this.readMeta("state") === "cancelled") {
      await this.abortWithTimeout();
      return;
    }
    this.setMeta("state", "running");
    await this.beginStallWatch();

    this.ctx.waitUntil(this.watchRun(operationId));
  }

  /** Read-only projection used by the Butler to re-present approvals. */
  async pendingApprovals(): Promise<
    {
      approvalId: string;
      tool: string;
      argsSummary: string;
      reason?: string;
    }[]
  > {
    return this.approvals.pending();
  }

  /**
   * Cheap liveness probe for the Butler's cron. Normally `onStart` has
   * already re-attached to a running run; this is the fallback for an
   * instance that could not, so the next probe can tell whether the run is
   * still being watched.
   */
  async liveness(): Promise<{ state: TaskState; reattached: boolean }> {
    await this.flushOutbox();
    const state = this.currentState();
    // Repair a chain whose scheduled check was lost with an eviction.
    if (state === "running" && this.spec?.botId === undefined) {
      await this.armStallCheckFromActivity();
    }
    const operationId = this.readMeta("operation_id");
    if (
      state !== "running" ||
      this.watchers > 0 ||
      this.hasCompletedEvent() ||
      operationId === undefined
    ) {
      return { state, reattached: false };
    }
    this.ctx.waitUntil(this.watchRun(operationId));
    return { state, reattached: true };
  }

  async status(): Promise<{ state: TaskState; title: string }> {
    await this.flushOutbox();
    return {
      state: this.currentState(),
      title: this.readMeta("title") ?? "",
    };
  }

  async steer(text: string): Promise<ControlResult> {
    await this.flushOutbox();
    const taskId = this.currentTaskId();
    const state = this.currentState();
    const locale = ownerLocale(this.env);
    if (!taskId) return { ok: false, message: steerNotStartedText(locale) };
    if (state !== "running") {
      return {
        ok: false,
        message: steerBlockedText(locale, taskId, state),
      };
    }

    await this.harness.session().steer(text);
    return { ok: true, message: steerOkText(locale, taskId) };
  }

  async cancel(): Promise<ControlResult> {
    await this.flushOutbox();
    const taskId = this.currentTaskId();
    const state = this.currentState();
    const locale = ownerLocale(this.env);
    if (!taskId) return { ok: false, message: cancelNotStartedText(locale) };
    if (state !== "queued" && state !== "running") {
      return {
        ok: false,
        message: cancelBlockedText(locale, taskId, state),
      };
    }

    // Terminal state and event come before `abort()`: aborting makes pi's
    // `wait` resolve as unanswered, and `fail()` ignores that only because
    // the state is already terminal.
    this.setMeta("state", "cancelled");
    await this.outboxFor(taskId).emit({ type: "cancelled" });
    await this.abortWithTimeout();
    // Only after the run stopped: an in-flight write must not land after cleanup.
    this.clearDrafts(taskId);

    return { ok: true, message: cancelOkText(locale, taskId) };
  }

  async retryTask(): Promise<ControlResult> {
    await this.flushOutbox();
    const taskId = this.currentTaskId();
    const state = this.currentState();
    const locale = ownerLocale(this.env);
    if (!taskId) return { ok: false, message: retryNotStartedText(locale) };
    if (state !== "failed") {
      return {
        ok: false,
        message: retryBlockedText(locale, taskId, state),
      };
    }

    const lastFailure = this.lastFailedEvent();
    if (!lastFailure?.retryable) {
      return { ok: false, message: retryNotRetryableText(locale, taskId) };
    }
    // A retried run is a new turn on a possibly fresh instance: its tool
    // declarations come from the registry, so install them first.
    await this.ensureMcpTools();
    await this.ensureBotTools();
    await this.ensureMailTools();
    await this.ensureExchangeTools();
    // Revives the tasks pi's crash-loop guard parked. False means nothing was
    // parked, followed by an ordinary run failure: re-attach to the run below.
    await this.harness.session().retry();
    this.setMeta("state", "running");
    await this.beginStallWatch();
    await this.outboxFor(taskId).emit({ type: "started" });

    const operationId = this.readMeta("operation_id") ?? `task:${taskId}`;
    this.setMeta("operation_id", operationId);
    this.ctx.waitUntil(this.watchRun(operationId));

    return { ok: true, message: retryOkText(locale, taskId) };
  }

  async handleAction(evt: ActionEvent): Promise<string> {
    await this.flushOutbox();
    if (evt.action === "cancel") return (await this.cancel()).message;
    if (evt.approvalId === undefined) {
      return missingApprovalIdText(ownerLocale(this.env));
    }
    return (
      await this.approvals.resolve(
        evt.approvalId,
        evt.action === "approve" ? "approved" : "rejected",
      )
    ).message;
  }

  /**
   * Load MCP tools once per object instance, after construction. The registry
   * is installed in the constructor but its extension list is published live,
   * so a later install is visible to the next model request.
   */
  private ensureMcpTools(): Promise<void> {
    this.mcpTools ??= (async () => {
      await this.installMcpTools();
      this.installCodemode();
    })();
    return this.mcpTools;
  }

  /**
   * Install the read-only mail tools once per object instance. Unconfigured
   * deployments get no tools and no prompt section.
   */
  private ensureMailTools(): Promise<void> {
    this.mailTools ??= this.installMailTools();
    return this.mailTools;
  }

  /**
   * Install the read-only exchange tools once per object instance. Unconfigured
   * deployments get no tools and no prompt section.
   */
  private ensureExchangeTools(): Promise<void> {
    this.exchangeTools ??= this.installExchangeTools();
    return this.exchangeTools;
  }

  private async installExchangeTools(): Promise<void> {
    const ext = exchangeExtension(this.env, {
      locale: () => ownerLocale(this.env),
      progress: (body) => this.emitProgress(body),
    });
    if (ext !== null) this.registry.install(ext);
  }

  private async installMailTools(): Promise<void> {
    const ext = mailExtension(this.env, {
      locale: () => ownerLocale(this.env),
      progress: (body) => this.emitProgress(body),
    });
    if (ext !== null) this.registry.install(ext);
  }

  /**
   * Install the bot's write-back tools once per object instance. Only tasks
   * spawned for a bot get them; the registry is installed in the constructor
   * but its extension list is published live.
   */
  private ensureBotTools(): Promise<void> {
    this.botTools ??= this.installBotTools();
    return this.botTools;
  }

  private async installBotTools(): Promise<void> {
    const botId = this.spec?.botId;
    if (!botId) return;

    const bot = this.env.BOT.get(this.env.BOT.idFromName(botId));
    const butler = this.env.BUTLER.get(this.env.BUTLER.idFromName("owner"));
    this.registry.install({
      name: "bot",
      tools: createBotTaskTools({
        bot,
        taskId: () => this.currentTaskId() ?? "",
        notify: (text) => butler.notifyFromBot(botId, text),
        approvals: this.approvals,
        locale: ownerLocale(this.env),
      }),
    });
  }

  private readonly completeReview: ReviewComplete = async (
    system,
    user,
    signal,
  ) => {
    const models = createModelsForEnv(this.env, this.meter);
    const ref = resolveModel(
      await effectiveModelRef(
        this.env,
        models,
        "task",
        this.spec?.model ?? readRuntimeConfig(this.env).models.task,
      ),
      this.env,
    );
    const model = models.getModel(ref.provider, ref.id);
    if (!model) {
      throw new Error(
        modelUnavailableShortText(ownerLocale(this.env), ref.provider, ref.id),
      );
    }
    const result = await models.completeSimple(
      model,
      {
        systemPrompt: system,
        messages: [{ role: "user", content: user, timestamp: Date.now() }],
      },
      oneShotOptions(`task.review:${this.ctx.id.toString()}`, signal),
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(result.errorMessage ?? result.stopReason);
    }
    return contentText(result.content);
  };

  private installCodemode(): void {
    let namespaces: NonNullable<Parameters<typeof createCodemodeExtension>[0]["namespaces"]> = [];
    try {
      namespaces = readRuntimeConfig(this.env).mcpServers.map((server) => ({
        name: server.name,
        prefix: `${server.name.replace(/[^A-Za-z0-9_-]/g, "_")}__`,
        description: server.description,
      }));
    } catch (error) {
      console.warn(`codemode namespaces skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.registry.install(createCodemodeExtension({
      // Half the default interrupt budget bounds synchronous QuickJS work.
      // Poll rate varies by script and host; this is not a wall-clock limit.
      sandbox: createInlineCodemodeSandbox({ interruptBudget: 50_000 }),
      namespaces,
      models: false,
      inlineBudget: 3000,
    }));
    this.registry.install(createToolSearchExtension());
  }

  private async installMcpTools(): Promise<void> {
    try {
      const servers = readRuntimeConfig(this.env).mcpServers;
      if (servers.length === 0) return;

      const loaded = await loadMcpTools(
        servers,
        this.mcpGates,
        mcpConnector(this.mcp, this.env, (server) =>
          this.env.MCP_AUTH.get(
            this.env.MCP_AUTH.idFromName("global"),
          ).accessToken(server.name, server.url),
        ),
        (body) => this.emitProgress(body),
      );
      const ext = mcpExtension(loaded);
      if (ext) this.registry.install(ext);
    } catch (error) {
      if (error instanceof RuntimeConfigError) {
        // Configuration is not a transient MCP failure: run without MCP tools
        // instead of rejecting `onStart` or caching a rejected promise.
        console.error(`task mcp tools skipped: ${error.code}`);
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`task mcp tools failed to load: ${reason}`);
    }
  }

  /**
   * Pi's `onReport` sink. A parked task means pi gave up restarting it after
   * `settings.restartLimit` crashes; report it retryable so the user can
   * resume it with `retryTask()`.
   */
  private async handleReport(
    _error: unknown,
    info: ReportInfo,
  ): Promise<void> {
    if (info.type === "task_parked") {
      await this.failWith(parkedTaskText(ownerLocale(this.env)), true);
      return;
    }
    if (info.type === "task_faulted" && info.reason === "restart_limit") {
      await this.failWith(parkedTaskText(ownerLocale(this.env)), true);
    }
  }

  private async abortWithTimeout(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ABORT_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([
        this.harness.session().abort(),
        timeout,
      ]);
      if (result === "timeout") {
        console.warn(
          `task ${this.currentTaskId() ?? "unknown"} cancel timed out waiting for abort`,
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `task ${this.currentTaskId() ?? "unknown"} abort failed: ${reason}`,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async watchRun(operationId: string): Promise<void> {
    // Set before the first await: startup calls this through `waitUntil`, and
    // a liveness probe must see the re-attachment as soon as it is requested.
    this.watchers += 1;
    try {
      // Re-attaching resumes Pi work, so it must wait out the lease. Startup
      // will re-attach from the persisted operation id on the next alarm.
      if (await this.deferStartupIfMaintenance()) return;
      let summary = "";
      try {
        const result = await this.harness.wait(operationId);
        if (result.status === "unanswered") {
          // Pi resolves `wait` for failed/aborted/withdrawn runs; they are not
          // completions, even when they carry no text.
          let modelError: string | undefined;
          if (result.reason === "model_error") {
            try {
              modelError = lastModelError(
                await this.harness.session().messages(),
              );
            } catch (error) {
              const reason =
                error instanceof Error ? error.message : String(error);
              console.warn(
                `task ${this.currentTaskId() ?? "unknown"} could not read the transcript after a model error: ${reason}`,
              );
            }
          }
          await this.fail(
            userTextForModelError(modelError, ownerLocale(this.env)) ??
              result.reason ??
              taskIncompleteText(ownerLocale(this.env)),
          );
          return;
        }
        summary = result.text ?? "";
      } catch (error) {
        await this.fail(error);
        return;
      }

      // `finish_task` may already have completed the task.
      if (this.readMeta("state") !== "running" || this.hasCompletedEvent()) {
        return;
      }
      await this.finish(summary, []);
    } finally {
      this.watchers -= 1;
    }
  }

  /**
   * 把模型给的 key 解析成产物。任何一条不合法都整体拒绝：宁可让模型改正，
   * 也不要发出一个本任务之外的、或者根本不存在的文件。
   */
  private async resolveArtifacts(
    entries: { key: string }[],
  ): Promise<Artifact[] | { error: string }> {
    const taskId = this.currentTaskId();
    if (!taskId) return { error: "任务尚未开始" }; // i18n-ignore: model-facing

    const resolved: Artifact[] = [];
    for (const { key } of entries) {
      const segments = artifactKeySegments(key);
      if (segments === null || segments[0] !== taskId) {
        return { error: `产物 key 不合法：${key}` }; // i18n-ignore: model-facing
      }
      const object = await this.env.ARTIFACTS.head(key);
      if (!object) return { error: `产物不存在：${key}` }; // i18n-ignore: model-facing
      if (object.size > MAX_ARTIFACT_BYTES) {
        return { error: `产物超过 15 MB：${key}` }; // i18n-ignore: model-facing
      }
      resolved.push({ name: artifactNameFromKey(key), key });
    }
    return resolved;
  }

  private async finish(summary: string, artifacts: Artifact[]): Promise<void> {
    // A cancelled task must not complete when a racing tool call returns.
    if (this.readMeta("state") === "cancelled") return;

    // Synchronous check-and-set: no await before the event row and state are
    // written, so concurrent callers cannot emit two completed events.
    if (this.hasCompletedEvent()) {
      this.setMeta("state", "completed");
      return;
    }

    const taskId = this.currentTaskId();
    if (!taskId) return;

    // `emit` inserts the event row synchronously (before its first await), so
    // the outbox can deliver it even if we crash before the state is stored.
    const delivery = this.outboxFor(taskId).emit({
      type: "completed",
      summary,
      artifacts,
    });
    this.setMeta("state", "completed");
    this.setMeta("summary", summary);
    this.clearDrafts(taskId);
    await delivery;
  }

  /** Drop a terminal task's private drafts without holding up its report. */
  private clearDrafts(taskId: string): void {
    this.ctx.waitUntil(
      clearWorkspace(this.env.ARTIFACTS, taskId).catch((error) => {
        console.warn(
          `task ${taskId} draft cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }),
    );
  }

  private async fail(error: unknown): Promise<void> {
    // An abort or a late completion after cancel/completed is expected.
    if (this.isTerminal()) return;

    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `task ${this.currentTaskId() ?? "unknown"} run failed: ${reason}`,
    );
    await this.failWith(reason, false);
  }

  private async failWith(reason: string, retryable: boolean): Promise<void> {
    if (this.isTerminal()) return;

    const taskId = this.currentTaskId();
    if (!taskId) return;

    // One failure per run: a second failure of the same run (after a retry
    // emitted a newer `started`) is still reported.
    if (this.hasFailedSinceLastStart()) {
      this.setMeta("state", "failed");
      if (!retryable) this.clearDrafts(taskId);
      return;
    }

    // Same crash-safe order as `finish`: the event row exists before state.
    const delivery = this.outboxFor(taskId).emit({
      type: "failed",
      reason,
      retryable,
    });
    this.setMeta("state", "failed");
    // A retryable failure may be resumed and needs its drafts; a terminal one
    // is done with them, same as `finish` and `cancel`.
    if (!retryable) this.clearDrafts(taskId);
    await delivery;
  }

  private isTerminal(): boolean {
    const state = this.readMeta("state");
    return (
      state === "completed" ||
      state === "cancelled" ||
      this.hasCompletedEvent()
    );
  }

  private hasCompletedEvent(): boolean {
    return this.hasEvent("completed");
  }

  private hasFailedSinceLastStart(): boolean {
    const row = this.db
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM events
         WHERE type = 'failed'
           AND seq > COALESCE((SELECT MAX(seq) FROM events WHERE type = 'started'), 0)`,
      )
      .toArray()[0];
    return (row?.count ?? 0) > 0;
  }

  private lastFailedEvent(): { retryable: boolean } | undefined {
    const row = this.db
      .exec<{ payload_json: string }>(
        `SELECT payload_json FROM events
         WHERE type = 'failed' ORDER BY seq DESC LIMIT 1`,
      )
      .toArray()[0];
    return row
      ? (JSON.parse(row.payload_json) as { retryable: boolean })
      : undefined;
  }

  private currentState(): TaskState {
    return (this.readMeta("state") ?? "queued") as TaskState;
  }

  private hasEvent(type: string): boolean {
    const row = this.db
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM events WHERE type = ?`,
        type,
      )
      .toArray()[0];
    return (row?.count ?? 0) > 0;
  }

  private async emitProgress(body: TaskEventBody): Promise<void> {
    const taskId = this.currentTaskId();
    if (!taskId) return;
    if (body.type === "progress") {
      // Display-only: bypass the outbox so tool steps write no event rows.
      const butler = this.env.BUTLER.get(this.env.BUTLER.idFromName("owner"));
      await butler.reportTaskProgress(taskId, body.text);
      return;
    }
    await this.outboxFor(taskId).emit(body);
  }

  private async flushOutbox(excludeRetryId?: string): Promise<void> {
    // Never deliver to the Butler while it is being exported or restored.
    if (await this.deferStartupIfMaintenance()) return;
    const taskId = this.currentTaskId();
    if (!taskId) return;

    let delivered = false;
    try {
      delivered = await this.outboxFor(taskId).flush(excludeRetryId);
    } catch (error) {
      console.error(
        `task ${taskId} outbox flush failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (delivered) {
      this.setMeta("outbox_retry_attempt", "0");
      return;
    }
    await this.scheduleOutboxRetry(excludeRetryId);
  }

  /**
   * Wake this object later to retry undelivered events. Only one retry is
   * pending at a time; each attempt backs off a little, capped at 10 minutes.
   *
   * `excludeRetryId` is the retry currently executing: the scheduler deletes
   * its job row only after the callback returns, so it must not count as a
   * pending retry. Schedules already due are ignored for the same reason
   * (they are running or about to run) and would otherwise suppress the
   * successor.
   */
  private async scheduleOutboxRetry(excludeRetryId?: string): Promise<void> {
    try {
      const now = Date.now();
      const pending = await this.listSchedules();
      if (
        pending.some(
          (schedule) =>
            schedule.callback === "retryOutbox" &&
            schedule.id !== excludeRetryId &&
            schedule.time * 1000 > now,
        )
      ) {
        return;
      }

      const attempt = Number(this.readMeta("outbox_retry_attempt") ?? "0");
      const delayMs = Math.min(30_000 * 2 ** attempt, 10 * 60_000);
      this.setMeta("outbox_retry_attempt", String(attempt + 1));
      await this.schedule(delayMs / 1000, "retryOutbox");
    } catch (error) {
      console.error(
        `task outbox retry schedule failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Scheduled callback: retry pending events after a delivery failure. */
  async retryOutbox(
    _payload?: unknown,
    schedule?: Schedule<unknown>,
  ): Promise<void> {
    await this.flushOutbox(schedule?.id);
  }

  /**
   * Scheduled callback: decide whether the current run has gone quiet for too
   * long. Reports at most once per stretch of inactivity; `StallWatch` clears
   * the notification flag on the next recorded activity.
   */
  async checkStall(
    _payload?: unknown,
    schedule?: Schedule<unknown>,
  ): Promise<void> {
    // A check can land after the run ended; a bot run never notifies the owner.
    if (this.currentState() !== "running" || this.spec?.botId !== undefined) {
      return;
    }

    const now = Date.now();
    // An unanswered approval is a legitimate wait; only postpone the check.
    if (this.approvals.pending().length > 0) {
      await this.scheduleStallCheck(now + STALL_AFTER_MS, schedule?.id);
      return;
    }
    const watch = this.stallWatch();
    const check = watch.check(now);
    if (check.due === "notify") {
      await this.emitProgress({
        type: "stalled",
        activity: check.activity,
        idleMs: check.idleMs,
      });
      watch.markNotified(now);
    }

    // After a notification, only new activity can re-arm the watch; keep
    // checking at the same cadence so a full threshold of new silence is
    // measured from that activity.
    await this.scheduleStallCheck(
      check.due === "notify" ? now + STALL_AFTER_MS : check.at,
      schedule?.id,
    );
  }

  /** Start watching a run that just moved to `running`. */
  private async beginStallWatch(): Promise<void> {
    if (this.spec?.botId !== undefined) return;
    const now = Date.now();
    this.stallWatch().record({ kind: "waiting_model" }, now);
    await this.scheduleStallCheck(now + STALL_AFTER_MS);
  }

  /**
   * Re-arm the watch from the stored activity. A run that was never observed
   * (no recorded activity) starts its clock now, as `waiting_model`.
   */
  private async armStallCheckFromActivity(): Promise<void> {
    const watch = this.stallWatch();
    let activityAt = watch.activityAt();
    if (activityAt === undefined) {
      this.recordActivity({ kind: "waiting_model" });
      activityAt = Date.now();
    }
    await this.scheduleStallCheck(activityAt + STALL_AFTER_MS);
  }

  private onToolStart(call: { id: string; name: string }): void {
    this.runningTools.set(call.id, call.name);
    this.recordActivity({ kind: "running_tool", tool: call.name });
  }

  private onToolEnd(call: { id: string }): void {
    this.runningTools.delete(call.id);
    // A parallel round can still have tools in flight; name the last one that
    // started, which is the one most likely to be the current bottleneck.
    const remaining = [...this.runningTools.values()];
    const tool = remaining[remaining.length - 1];
    this.recordActivity(
      tool === undefined
        ? { kind: "waiting_model" }
        : { kind: "running_tool", tool },
    );
  }

  private onModelResponse(): void {
    // Tools in flight will update the activity themselves when they finish;
    // the model answering for them must not hide a running tool.
    if (this.runningTools.size > 0) return;
    this.recordActivity({ kind: "waiting_model" });
  }

  private recordActivity(activity: TaskActivity): void {
    try {
      this.stallWatch().record(activity, Date.now());
    } catch (error) {
      // Activity is bookkeeping: a storage hiccup must not block a tool.
      console.warn(
        `task activity record failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Re-record the current activity, e.g. when an approval changes state. */
  private touchActivity(): void {
    try {
      const watch = this.stallWatch();
      this.recordActivity(watch.activity() ?? { kind: "waiting_model" });
    } catch (error) {
      console.warn(
        `task activity record failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private stallWatch(): StallWatch {
    return new StallWatch({
      read: (key) => this.readMeta(key),
      write: (key, value) => this.setMeta(key, value),
    });
  }

  /**
   * Keep exactly one pending stall check. Like the outbox retry, a schedule
   * that is already due is ignored: it is running or about to run, and would
   * otherwise suppress its successor.
   */
  private async scheduleStallCheck(
    atMs: number,
    excludeId?: string,
  ): Promise<void> {
    try {
      const now = Date.now();
      const pending = await this.listSchedules();
      if (
        pending.some(
          (schedule) =>
            schedule.callback === "checkStall" &&
            schedule.id !== excludeId &&
            schedule.time * 1000 > now,
        )
      ) {
        return;
      }

      const at = Math.max(atMs, now + 60_000);
      await this.schedule((at - now) / 1000, "checkStall");
    } catch (error) {
      console.error(
        `task stall check schedule failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private outboxFor(taskId: string): Outbox {
    this.outbox ??= new Outbox(
      this.db,
      taskId,
      (event) => this.deliver(event),
      (excludeRetryId) => this.scheduleOutboxRetry(excludeRetryId),
    );
    return this.outbox;
  }

  private async deliver(event: TaskEvent): Promise<void> {
    const butler = this.env.BUTLER.get(this.env.BUTLER.idFromName("owner"));
    await butler.report(event);
  }

  private async butlerMaintenanceActive(): Promise<boolean> {
    const butler = this.env.BUTLER.get(this.env.BUTLER.idFromName("owner"));
    return butler.maintenanceActive();
  }

  private async assertNoMaintenance(): Promise<void> {
    let active: boolean;
    try {
      active = await this.butlerMaintenanceActive();
    } catch {
      active = true;
    }
    if (active) throw new Error("maintenance lease active");
  }

  /**
   * Fail closed on an unknown lease state: the Butler may be unreachable
   * exactly while a restore is in progress. Setting the persisted flag makes
   * the next alarm resume startup even though onStart already ran.
   */
  private async deferStartupIfMaintenance(): Promise<boolean> {
    let active: boolean;
    try {
      active = await this.butlerMaintenanceActive();
    } catch {
      active = true;
    }
    if (!active) return false;
    this.setMeta("startup_deferred", "1");
    await this.ctx.storage.setAlarm(Date.now() + DEFER_MS);
    return true;
  }

  private currentTaskId(): string | undefined {
    return this.readMeta("task_id") ?? this.spec?.taskId;
  }

  private readMeta(key: string): string | undefined {
    return this.db
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)
      .toArray()[0]?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }
}
