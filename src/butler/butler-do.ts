import { Agent } from "agents";
import { PiHarness, type PiModel } from "agents/harness/pi";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { getChannelOverride } from "../channels/override";
import { createTelegramAdapter } from "../channels/telegram";
import type { ChannelAdapter } from "../channels/types";
import { config } from "../config";
import { createModelsForEnv, resolveModel } from "../llm/models";
import type { MessageEvent, TaskEvent, TaskEventBody } from "../protocol";
import { butlerSystemPrompt } from "./prompt";
import { TasksRepo } from "./tasks-repo";
import { createButlerTools } from "./tools";

type TaskEventRow = {
  seq: number;
  type: string;
  payload_json: string;
};

/**
 * Control-plane object: the Butler agent lives here. It converses with the
 * owner, dispatches background tasks and keeps their index.
 */
export class ButlerDO extends Agent<Env> {
  readonly registry = createRegistry();

  readonly harness: PiHarness;

  private readonly db: SqlStorage;

  private readonly repo: TasksRepo;

  /** The model last applied to the Butler session (see `ensureModel`). */
  private appliedModel: PiModel | undefined;

  private channelInstance: ChannelAdapter | undefined;

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

    this.repo = new TasksRepo(this.db);

    // Installed once, at construction: Pi may re-run the harness factory after
    // a storage error, so registry changes must not depend on it.
    this.registry.install({
      name: "butler",
      tools: createButlerTools({
        repo: this.repo,
        chatId: () => this.readMeta("chat_id"),
        send: (chatId, msg) => this.channel().send(chatId, msg),
        task: (id) => this.env.TASK.get(this.env.TASK.idFromName(id)),
      }),
      sections: [{ key: "butler", render: () => butlerSystemPrompt() }],
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
        model: resolveModel(config.models.butler, this.env),
      },
    });

    // `Agent` already installed the lifecycle; adding to it is required.
    this.lifecycle.use(this.harness);
  }

  /**
   * RPC entry for inbound channel messages. `Agent` reserves the name
   * `onMessage` for its hibernating-WebSocket handler (and hide it from RPC),
   * so the gateway's `onMessage` is mapped here in `src/index.ts`.
   */
  async handleMessage(evt: MessageEvent): Promise<void> {
    try {
      await this.handleInboundMessage(evt);
    } catch (error) {
      console.error("butler message failed:", error);
      await this.sendBestEffort(evt.chatId, "出错了，稍后再试");
    }
  }

  async report(event: TaskEvent): Promise<void> {
    const now = Date.now();

    // Events can arrive before the Butler has spawned/indexed the task.
    if (!this.repo.get(event.taskId)) {
      this.repo.insert({ id: event.taskId, title: "", chatId: null });
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

  private async handleInboundMessage(evt: MessageEvent): Promise<void> {
    // Single-owner setup: remember where notifications go.
    this.setMeta("chat_id", evt.chatId);

    if (evt.text === null) {
      await this.channel().send(evt.chatId, { text: "目前只支持文字消息" });
      return;
    }

    // Tests replace the model per message; in production this is a no-op after
    // the first message of an object instance.
    await this.ensureModel();

    const operationId = `tg:${evt.updateId}`;
    const receipt = await this.harness.submit(evt.text, { operationId });
    // Telegram redelivered an update we already accepted: never answer twice.
    if (!receipt.accepted) return;

    const result = await this.harness.wait(operationId);
    if (result.status === "unanswered") {
      await this.channel().send(evt.chatId, { text: "出错了，稍后再试" });
      return;
    }
    if (result.text) {
      await this.channel().send(evt.chatId, { text: result.text });
    }
  }

  private async ensureModel(): Promise<void> {
    const model = resolveModel(config.models.butler, this.env);
    if (
      this.appliedModel?.provider === model.provider &&
      this.appliedModel.id === model.id
    ) {
      return;
    }
    await this.harness.session().setModel(model);
    this.appliedModel = model;
  }

  private async sendBestEffort(chatId: string, text: string): Promise<void> {
    try {
      await this.channel().send(chatId, { text });
    } catch (error) {
      console.error("butler error reply failed:", error);
    }
  }

  private channel(): ChannelAdapter {
    const override = getChannelOverride();
    if (override) return override;
    this.channelInstance ??= createTelegramAdapter({
      token: this.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: this.env.TELEGRAM_WEBHOOK_SECRET,
    });
    return this.channelInstance;
  }

  private readMeta(key: string): string | null {
    return (
      this.db
        .exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)
        .toArray()[0]?.value ?? null
    );
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
