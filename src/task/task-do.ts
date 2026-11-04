import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
import { httpRequestTool, safeRequestUrl } from "../tools/http-request";
import { getArtifactTool, safeArtifactRef } from "../tools/get-artifact";
import { nowTool } from "../tools/now";
import { Agent, type Schedule } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type ReportInfo,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { BackupRpc } from "../admin/backup-rpc";
import { DEFER_MS } from "../admin/maintenance";
import type {
  DbSchema,
  DumpPage,
  DumpRow,
  TableSchema,
} from "../admin/sql-dump";
import { createBotTaskTools } from "../bot/bot-tools";
import { RuntimeConfigError, readRuntimeConfig } from "../runtime-config";
import { lastModelError, userTextForModelError } from "../llm/model-errors";
import { createModelsForEnv, modelReadiness, resolveModel } from "../llm/models";
import type {
  ActionEvent,
  Artifact,
  TaskEvent,
  TaskEventBody,
  TaskSpec,
} from "../protocol";
import { saveArtifactTool } from "../tools/artifacts";
import { loadMcpTools, mcpConnector, mcpExtension } from "../tools/mcp";
import { webFetchTool } from "../tools/web-fetch";
import { webSearchTool } from "../tools/web-search";
import { withProgress } from "../tools/wrap";
import { ApprovalGate } from "./approvals";
import { Outbox } from "./outbox";
import { taskSystemPrompt } from "./prompt";

export type TaskState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

const STATE_LABELS: Record<TaskState, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
};

type ControlResult = { ok: boolean; message: string };

/** How long `cancel()` waits for pi to become idle before returning anyway. */
const ABORT_TIMEOUT_MS = 10_000;

const FinishTask = Type.Object({
  summary: Type.String(),
  artifacts: Type.Optional(
    Type.Array(Type.Object({ name: Type.String(), url: Type.String() })),
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

  readonly approvals: ApprovalGate;

  /** Resolves once MCP tools were loaded and installed on this instance. */
  private mcpTools: Promise<void> | undefined;

  /** Resolves once this bot run installed its write-back tools. */
  private botTools: Promise<void> | undefined;

  private readonly db: SqlStorage;

  private readonly backup: BackupRpc;

  private spec: TaskSpec | null;

  private outbox: Outbox | undefined;

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

    this.approvals = new ApprovalGate(this.db, (body) =>
      this.emitProgress(body),
    );

    const finishTask: ToolRegistration<typeof FinishTask> = {
      name: "finish_task",
      description:
        "Finish the task with a concise summary and its artifacts. Required to deliver results.",
      parameters: FinishTask,
      callers: ["model"],
      // Has side effects (reports completion); must not replay after a restart.
      execute: async ({ summary, artifacts }) => {
        await this.finish(summary, artifacts ?? []);
        return { output: [{ type: "text", text: "Task finished." }] };
      },
    };

    // Installed once, at construction: Pi may re-run the harness factory after
    // a storage error, so registry changes must not depend on it.
    this.registry.install({
      name: "task",
      tools: [finishTask],
      sections: [
        {
          key: "task",
          render: () => (this.spec ? taskSystemPrompt(this.spec) : undefined),
        },
      ],
    });

    const emitProgress = (body: TaskEventBody) => this.emitProgress(body);
    this.registry.install({
      name: "execution",
      tools: [
        withProgress(
          webSearchTool(),
          emitProgress,
          (args) => `搜索：${args.query}`,
        ),
        withProgress(
          getArtifactTool(this.env.ARTIFACTS, this.env.PUBLIC_BASE_URL),
          emitProgress,
          (args) => `读取产物：${safeArtifactRef(args.ref)}`,
        ),
        withProgress(
          httpRequestTool(this.approvals),
          emitProgress,
          (args) => `${args.method ?? "GET"} ${safeRequestUrl(args.url)}`,
        ),
        withProgress(nowTool(), emitProgress, () => "查看时间"),
        withProgress(webFetchTool(), emitProgress, (args) => `读取：${args.url}`),
        withProgress(
          saveArtifactTool(
            this.env.ARTIFACTS,
            () => this.currentTaskId() ?? "",
            this.env.PUBLIC_BASE_URL,
            () => this.assertNoMaintenance(),
          ),
          emitProgress,
          (args) => `保存：${args.filename}`,
        ),
      ],
    });

    // Model selection happens in `start` once the spec is available. Keeping
    // the constructor config-free lets alarms and control RPCs run without a
    // readable DESKWAND_CONFIG.
    this.harness = new PiHarness({
      harness: async ({ storage, context, onWake }) => {
        const harness = await Harness.open(
          storage,
          {
            models: createModelsForEnv(this.env),
            registry: this.registry,
            onWake,
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
      this.setMeta("task_id", spec.taskId);
      this.setMeta("title", spec.title);
      this.setMeta("spec", JSON.stringify(spec));
    }

    const effective = this.spec ?? spec;
    const operationId = `task:${effective.taskId}`;
    this.setMeta("operation_id", operationId);

    const outbox = this.outboxFor(effective.taskId);

    // The harness defaults are built in the constructor, before a fresh DO
    // knows its spec, so the model is chosen per session here.
    await this.harness
      .session()
      .setModel(
        resolveModel(
          effective.model ?? readRuntimeConfig(this.env).models.task,
          this.env,
        ),
      );

    // Durable before submit and only once: retries and very fast runs must not
    // let `completed` get a lower seq than `started`.
    if (!this.hasEvent("started")) {
      await outbox.emit({ type: "started" });
    }

    // A cancel can land while this start is setting up.
    if (this.readMeta("state") === "cancelled") return;

    // Refuse before any tool setup or model work: a missing key or an
    // unavailable model is a permanent failure, not a retryable one.
    const ref = effective.model ?? readRuntimeConfig(this.env).models.task;
    const notReady = modelReadiness(
      this.env,
      createModelsForEnv(this.env),
      ref,
    );
    if (notReady) {
      await this.failWith(notReady, false);
      return;
    }

    // MCP tools are loaded outside the harness factory so a restart never
    // rebuilds them mid-run; install them before the model can ask for one.
    await this.ensureMcpTools();
    await this.ensureBotTools();

    await this.harness.submit(effective.instructions, { operationId });

    // …or while the submit is in flight: stop the run it just accepted.
    if (this.readMeta("state") === "cancelled") {
      await this.abortWithTimeout();
      return;
    }
    this.setMeta("state", "running");

    this.ctx.waitUntil(this.watchRun(operationId));
  }

  /** Read-only projection used by the Butler to re-present approvals. */
  async pendingApprovals(): Promise<
    { approvalId: string; tool: string; argsSummary: string }[]
  > {
    return this.approvals.pending();
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
    if (!taskId) return { ok: false, message: "任务尚未开始，无法追加指令" };
    if (state !== "running") {
      return {
        ok: false,
        message: `任务 ${taskId} 已${STATE_LABELS[state]}，无法追加指令`,
      };
    }

    await this.harness.session().steer(text);
    return { ok: true, message: `已向任务 ${taskId} 追加指令` };
  }

  async cancel(): Promise<ControlResult> {
    await this.flushOutbox();
    const taskId = this.currentTaskId();
    const state = this.currentState();
    if (!taskId) return { ok: false, message: "任务尚未开始，无法取消" };
    if (state !== "queued" && state !== "running") {
      return {
        ok: false,
        message: `任务 ${taskId} 已${STATE_LABELS[state]}，无法取消`,
      };
    }

    // Terminal state and event come before `abort()`: aborting makes pi's
    // `wait` resolve as unanswered, and `fail()` ignores that only because
    // the state is already terminal.
    this.setMeta("state", "cancelled");
    await this.outboxFor(taskId).emit({ type: "cancelled" });
    await this.abortWithTimeout();

    return { ok: true, message: `任务 ${taskId} 已取消` };
  }

  async retryTask(): Promise<ControlResult> {
    await this.flushOutbox();
    const taskId = this.currentTaskId();
    const state = this.currentState();
    if (!taskId) return { ok: false, message: "任务尚未开始，无法重试" };
    if (state !== "failed") {
      return {
        ok: false,
        message: `任务 ${taskId} 已${STATE_LABELS[state]}，无法重试`,
      };
    }

    const lastFailure = this.lastFailedEvent();
    if (!lastFailure?.retryable) {
      return { ok: false, message: `任务 ${taskId} 的失败不可重试` };
    }
    // A retried run is a new turn on a possibly fresh instance: its tool
    // declarations come from the registry, so install them first.
    await this.ensureMcpTools();
    await this.ensureBotTools();
    // Revives the tasks pi's crash-loop guard parked. False means nothing was
    // parked, followed by an ordinary run failure: re-attach to the run below.
    await this.harness.session().retry();
    this.setMeta("state", "running");
    await this.outboxFor(taskId).emit({ type: "started" });

    const operationId = this.readMeta("operation_id") ?? `task:${taskId}`;
    this.setMeta("operation_id", operationId);
    this.ctx.waitUntil(this.watchRun(operationId));

    return { ok: true, message: `任务 ${taskId} 已重新开始` };
  }

  async handleAction(evt: ActionEvent): Promise<string> {
    await this.flushOutbox();
    if (evt.action === "cancel") return (await this.cancel()).message;
    if (evt.approvalId === undefined) return "缺少审批编号";
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
      }),
    });
  }

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
        this.approvals,
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
      await this.failWith("任务反复中断，已暂停", true);
      return;
    }
    if (info.type === "task_faulted" && info.reason === "restart_limit") {
      await this.failWith("任务反复中断，已暂停", true);
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
          userTextForModelError(modelError) ?? result.reason ?? "任务未完成",
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
    await delivery;
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
      return;
    }

    // Same crash-safe order as `finish`: the event row exists before state.
    const delivery = this.outboxFor(taskId).emit({
      type: "failed",
      reason,
      retryable,
    });
    this.setMeta("state", "failed");
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
