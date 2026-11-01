import { Agent, type RetryOptions } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type ReportInfo,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { config } from "../config";
import { createModelsForEnv, resolveModel } from "../llm/models";
import type {
  ActionEvent,
  Artifact,
  TaskEvent,
  TaskEventBody,
  TaskSpec,
} from "../protocol";
import { saveArtifactTool } from "../tools/artifacts";
import { webFetchTool } from "../tools/web-fetch";
import { webSearchTool } from "../tools/web-search";
import { withProgress } from "../tools/wrap";
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

type AgentRetryOptions = RetryOptions & {
  shouldRetry?: (error: unknown, nextAttempt: number) => boolean;
};

/** How long `cancel()` waits for pi to become idle before returning anyway. */
const ABORT_TIMEOUT_MS = 10_000;

const FinishTask = Type.Object({
  summary: Type.String(),
  artifacts: Type.Optional(
    Type.Array(Type.Object({ name: Type.String(), url: Type.String() })),
  ),
});

/**
 * Execution-plane object: one instance per task, hosting a Pi sub-agent.
 * It never talks to a channel; everything is reported to the Butler through
 * the durable `Outbox`.
 */
export class TaskDO extends Agent<Env> {
  readonly registry = createRegistry();

  readonly harness: PiHarness;

  private readonly db: SqlStorage;

  private spec: TaskSpec | null;

  private outbox: Outbox | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;

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

    const finishTask: ToolRegistration<typeof FinishTask> = {
      name: "finish_task",
      description:
        "Finish the task with a concise summary and its artifacts. Required to deliver results.",
      parameters: FinishTask,
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
          webSearchTool(this.env.TAVILY_API_KEY),
          emitProgress,
          (args) => `搜索：${args.query}`,
        ),
        withProgress(webFetchTool(), emitProgress, (args) => `读取：${args.url}`),
        withProgress(
          saveArtifactTool(
            this.env.ARTIFACTS,
            () => this.currentTaskId() ?? "",
            this.env.PUBLIC_BASE_URL,
          ),
          emitProgress,
          (args) => `保存：${args.filename}`,
        ),
      ],
    });

    this.harness = new PiHarness({
      harness: ({ storage, context, onWake }) =>
        Harness.open(
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
        ),
      defaults: {
        model: resolveModel(
          this.spec?.model ?? config.models.task,
          this.env,
        ),
      },
    });

    // `Agent` already installed the lifecycle; adding to it is required.
    this.lifecycle.use(this.harness);
  }

  override async onStart(_props?: object): Promise<void> {
    await super.onStart(_props);
    await this.flushOutbox();

    // `wait` reads storage, so this survives restarts: re-attach to a run
    // that was still going when the object was evicted.
    if (this.readMeta("state") === "running") {
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
    await this.flushOutbox();
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
        resolveModel(effective.model ?? config.models.task, this.env),
      );

    // Durable before submit and only once: retries and very fast runs must not
    // let `completed` get a lower seq than `started`.
    if (!this.hasEvent("started")) {
      await outbox.emit({ type: "started" });
    }

    // A cancel can land while this start is setting up.
    if (this.readMeta("state") === "cancelled") return;

    await this.harness.submit(effective.instructions, { operationId });

    // …or while the submit is in flight: stop the run it just accepted.
    if (this.readMeta("state") === "cancelled") {
      await this.abortWithTimeout();
      return;
    }
    this.setMeta("state", "running");

    this.ctx.waitUntil(this.watchRun(operationId));
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

  // `Agent` names its generic backoff helper `retry`, and the task-control
  // RPC shares the name: a call with no callback resumes the failed task.
  // (The no-argument overload must stay last: workerd's RPC typing picks it.)
  override retry<T>(
    fn: (attempt: number) => Promise<T>,
    options?: AgentRetryOptions,
  ): Promise<T>;
  override retry(): Promise<ControlResult>;
  override async retry<T>(
    fn?: (attempt: number) => Promise<T>,
    options?: AgentRetryOptions,
  ): Promise<ControlResult | T> {
    if (fn) return super.retry(fn, options);

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
    return "暂不支持";
  }

  /**
   * Pi's `onReport` sink. A parked task means pi gave up restarting it after
   * `settings.restartLimit` crashes; report it retryable so the user can
   * resume it with `retry()`.
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
    let summary = "";
    try {
      const result = await this.harness.wait(operationId);
      if (result.status === "unanswered") {
        // Pi resolves `wait` for failed/aborted/withdrawn runs; they are not
        // completions, even when they carry no text.
        await this.fail(result.reason ?? "任务未完成");
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
    await this.outboxFor(taskId).emit(body);
  }

  private async flushOutbox(): Promise<void> {
    const taskId = this.currentTaskId();
    if (!taskId) return;
    await this.outboxFor(taskId).flush();
  }

  private outboxFor(taskId: string): Outbox {
    this.outbox ??= new Outbox(this.db, taskId, (event) => this.deliver(event));
    return this.outbox;
  }

  private async deliver(event: TaskEvent): Promise<void> {
    const butler = this.env.BUTLER.get(this.env.BUTLER.idFromName("owner"));
    await butler.report(event);
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
