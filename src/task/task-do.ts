import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
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

    await this.harness.submit(effective.instructions, { operationId });
    this.setMeta("state", "running");

    this.ctx.waitUntil(this.watchRun(operationId));
  }

  async status(): Promise<{ state: TaskState; title: string }> {
    await this.flushOutbox();
    return {
      state: (this.readMeta("state") ?? "queued") as TaskState,
      title: this.readMeta("title") ?? "",
    };
  }

  async handleAction(_evt: ActionEvent): Promise<string> {
    await this.flushOutbox();
    return "暂不支持";
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
    const state = this.readMeta("state");
    if (
      state === "completed" ||
      state === "cancelled" ||
      this.hasCompletedEvent()
    ) {
      return;
    }

    const taskId = this.currentTaskId();
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`task ${taskId ?? "unknown"} run failed: ${reason}`);
    if (!taskId) return;

    if (this.hasEvent("failed")) {
      this.setMeta("state", "failed");
      return;
    }

    // Same crash-safe order as `finish`: the event row exists before state.
    const delivery = this.outboxFor(taskId).emit({
      type: "failed",
      reason,
      retryable: false,
    });
    this.setMeta("state", "failed");
    await delivery;
  }

  private hasCompletedEvent(): boolean {
    return this.hasEvent("completed");
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
