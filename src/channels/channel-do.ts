import { Agent, type Schedule } from "agents";
import { isOwner } from "../config";
import { readRuntimeConfig } from "../runtime-config";
import {
  decodeAction,
  type ActionEvent,
  type AdmittedMessage,
  type ChannelId,
  type ChannelMessageRef,
  type InboundEvent,
  type MessageEvent,
  type OutboundMessage,
  type RouteSnapshot,
} from "../protocol";
import {
  getChannelOverride,
  getILinkFetchOverride,
  getPollTimingOverride,
  getWeChatCredentialsOverride,
} from "./override";
import {
  DISABLED_ROUTE_KEY,
  parseActiveChannel,
  routeIdentity,
  sha256Hex,
  versionIdOf,
} from "./route-identity";
import { emitChannelEvent } from "./events";
import { createTelegramAdapter } from "./telegram";
import { parseTextAction, type TextAction } from "./text-action";
import { ChannelError, type ChannelAdapter } from "./types";
import { toWeChatText } from "./wechat/markdown";
import {
  createILinkClient,
  ILinkError,
  isSessionExpired,
  isTrustedBaseUrl,
  parseCredentials,
  type WeChatCredentials,
  type WeChatUpdate,
} from "./wechat/ilink";

const WECHAT_POLL_RUN_MS = 600_000;
const WECHAT_POLL_BACKOFF_MS = 1_000;
const WECHAT_POLL_MAX_BACKOFF_MS = 10_000;
const WECHAT_GET_UPDATES_TIMEOUT_MS = 40_000;
const WECHAT_HEARTBEAT_MAX_AGE_MS = 120_000;
type WeChatState = {
  credentials_hash: string | null;
  cursor: string | null;
  status: string | null;
  last_poll_at: number | null;
  expiry_notified: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function credentialsHash(json: string): Promise<string> {
  return sha256Hex(json);
}

const ACTION_LABELS = {
  approve: "批准",
  reject: "拒绝",
  cancel: "取消",
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps an iLink/network failure to a fixed diagnostic code. The raw error text
 * is never logged as an event field.
 */
function wechatErrorCode(error: unknown): string {
  if (error instanceof ILinkError) {
    if (error.status === 0) return "untrusted_origin";
    if (error.status === 429) return "rate_limited";
    if (error.status >= 500) return "upstream_error";
    return "api_error";
  }
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return "network_timeout";
  }
  return "network_error";
}

/** Drop buttons and turn each one into an instruction the owner can type. */
function forWechat(msg: OutboundMessage): OutboundMessage {
  const text = toWeChatText(msg.text);
  if (!msg.buttons || msg.buttons.length === 0) return { text };

  const hints: string[] = [];
  for (const row of msg.buttons) {
    for (const button of row) {
      const decoded = decodeAction(button.data);
      if (!decoded) continue;
      const approval = decoded.approvalId ? ` ${decoded.approvalId}` : "";
      hints.push(
        `回复"${ACTION_LABELS[decoded.action]} ${decoded.taskId}${approval}"`,
      );
    }
  }

  return hints.length === 0
    ? { text }
    : { text: `${text}\n${hints.join("\n")}` };
}

/**
 * Single channel hub: the only place that talks to a channel API, and the only
 * place inbound channel events enter the control plane.
 */
export class ChannelDO extends Agent<Env> {
  private readonly db: SqlStorage;

  private telegramInstance: ChannelAdapter | undefined;
  private activeWeChatRun: {
    hash: string;
    raw: string;
    routeKey: string;
  } | null = null;
  /** Cached for the lifetime of this instance: its environment is immutable. */
  private routePromise: Promise<RouteSnapshot> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS owner_addresses (
        channel TEXT PRIMARY KEY,
        conversation_id TEXT,
        updated_at INTEGER
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS wechat_state (
        credentials_hash TEXT,
        cursor TEXT,
        status TEXT,
        last_poll_at INTEGER,
        expiry_notified INTEGER
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS wechat_contexts (
        user_id TEXT PRIMARY KEY,
        context_token TEXT,
        updated_at INTEGER
      )`,
    );
  }

  override async onStart(props?: object): Promise<void> {
    await super.onStart(props);
    // First wake (any existing RPC or the Cron) applies the selection early.
    try {
      await this.ensurePolling();
    } catch (error) {
      console.error(`channel: startup polling failed: ${errorMessage(error)}`);
    }
  }

  async handleTelegramWebhook(req: Request): Promise<void> {
    try {
      const adapter = this.adapter("telegram");

      let event: InboundEvent | null;
      try {
        event = await adapter.parseInbound(req);
      } catch (error) {
        emitChannelEvent(this.env, {
          channel: "telegram",
          event: "webhook_rejected",
          errorCode: "payload_invalid",
        });
        console.error(
          `channel: failed to parse update: ${errorMessage(error)}`,
        );
        return;
      }
      if (!event) return;

      if (!this.isOwner(event)) {
        console.warn(`channel: ignoring event from non-owner ${event.userId}`);
        return;
      }

      this.rememberOwner(event);
      emitChannelEvent(this.env, { channel: "telegram", event: "webhook_ok" });

      // The other channel's input must not reach the Butler or a task.
      const route = await this.currentRoute();
      if (route.channel !== "telegram") {
        if (event.type === "action") {
          try {
            await adapter.answerAction(event.actionId, "该渠道未启用");
          } catch (error) {
            console.error(
              `channel: answer callback failed: ${errorMessage(error)}`,
            );
          }
        }
        return;
      }

      if (event.type === "message") {
        this.dispatchMessage(event, route.routeKey);
        return;
      }

      let text = "出错了，稍后再试";
      try {
        const task = this.env.TASK.get(
          this.env.TASK.idFromName(event.taskId),
        );
        text = await task.handleAction(event);
      } catch (error) {
        console.error(`channel: action failed: ${errorMessage(error)}`);
      }

      try {
        await adapter.answerAction(event.actionId, text);
      } catch (error) {
        console.error(
          `channel: answer callback failed: ${errorMessage(error)}`,
        );
      }
    } catch (error) {
      // The webhook must always be acknowledged, even for an unexpected bug.
      console.error(`channel: webhook failed: ${errorMessage(error)}`);
    }
  }

  /**
   * The selection this instance executes: the active channel and the route key
   * that scopes message references to this deployment and target account.
   */
  async currentRoute(): Promise<RouteSnapshot> {
    this.routePromise ??= this.resolveRoute();
    return this.routePromise;
  }

  /** True while `routeKey` still describes this instance's selection. */
  async isAdmissionCurrent(
    channel: ChannelId,
    routeKey: string,
  ): Promise<boolean> {
    const route = await this.currentRoute();
    return route.channel === channel && route.routeKey === routeKey;
  }

  /** Sends on the selected channel and returns the owned message reference. */
  async sendCurrent(message: OutboundMessage): Promise<ChannelMessageRef> {
    const route = await this.currentRoute();
    if (route.channel === null) {
      throw new ChannelError("channel selection disabled", 0);
    }

    return this.sendOnRoute(route.channel, route.routeKey, message);
  }

  /** Edits only a reference owned by this instance's current route. */
  async editCurrent(
    ref: ChannelMessageRef,
    message: OutboundMessage,
  ): Promise<boolean> {
    const route = await this.currentRoute();
    if (
      route.channel === null ||
      ref.channel !== route.channel ||
      ref.routeKey !== route.routeKey ||
      ref.messageId === null ||
      route.channel === "wechat"
    ) {
      return false;
    }

    if (ref.conversationId !== this.currentAddress(route.channel)) {
      return false;
    }

    await this.adapter(route.channel).edit(
      ref.conversationId,
      ref.messageId,
      message,
    );
    return true;
  }

  private async resolveRoute(): Promise<RouteSnapshot> {
    const versionId = versionIdOf(this.env.CF_VERSION_METADATA);
    if (versionId === null) {
      console.error("channel: missing CF_VERSION_METADATA binding");
      return { channel: null, routeKey: DISABLED_ROUTE_KEY };
    }

    const channel = parseActiveChannel(this.env.ACTIVE_CHANNEL);
    if (channel === null) {
      console.error("channel: invalid ACTIVE_CHANNEL");
      return { channel: null, routeKey: DISABLED_ROUTE_KEY };
    }

    return routeIdentity({
      versionId,
      channel,
      targetIdentityHash: await this.targetIdentityHash(channel),
    });
  }

  /** Hashes the selected channel's account identity; never stores it plainly. */
  private targetIdentityHash(channel: ChannelId): Promise<string> {
    if (channel === "wechat") {
      // Route ownership comes from the deployed secret only: the test-only
      // polling override must never move an existing message reference.
      const raw = this.env.WECHAT_CREDENTIALS ?? null;
      return raw ? credentialsHash(raw) : sha256Hex("wechat:unconfigured");
    }

    const ownerIds = [
      ...new Set(readRuntimeConfig(this.env).owner.telegramUserIds),
    ].sort((a, b) => a - b);
    return sha256Hex(
      `telegram:${this.env.TELEGRAM_BOT_TOKEN ?? ""}:${ownerIds.join(",")}`,
    );
  }

  private async sendOnRoute(
    channel: ChannelId,
    routeKey: string,
    msg: OutboundMessage,
  ): Promise<ChannelMessageRef> {
    const conversationId = this.currentAddress(channel);
    const outbound = channel === "wechat" ? forWechat(msg) : msg;
    const sent = await this.adapter(channel).send(conversationId, outbound);
    if (channel === "telegram") {
      emitChannelEvent(this.env, { channel: "telegram", event: "send_ok" });
    }
    return {
      channel,
      conversationId,
      routeKey,
      messageId: sent.messageId || null,
    };
  }

  /** Selected channel's conversation; never falls back to the other channel. */
  private currentAddress(channel: ChannelId): string {
    const row = this.db
      .exec<{ conversation_id: string }>(
        `SELECT conversation_id FROM owner_addresses WHERE channel = ?`,
        channel,
      )
      .toArray()[0];
    if (row) return row.conversation_id;

    if (channel === "telegram") {
      const fallback = readRuntimeConfig(this.env).owner.telegramUserIds[0];
      if (fallback !== undefined) return String(fallback);
    }

    throw new ChannelError(`no ${channel} address`, 0);
  }

  async ensurePolling(): Promise<void> {
    const route = await this.currentRoute();

    if (route.channel !== "wechat") {
      await this.stopWeChatPolling();
      return;
    }

    await this.startWeChatPolling();
  }

  /** Stops the WeChat chain without discarding the selected credential. */
  private async stopWeChatPolling(): Promise<void> {
    this.activeWeChatRun = null;

    for (const schedule of await this.listSchedules()) {
      if (schedule.callback === "pollWeChat") {
        await this.cancelSchedule(schedule.id);
      }
    }

    // A deliberate deactivation is not an expiry: keep cursor and contexts so
    // selecting WeChat again resumes where it left off.
    if (this.readWeChatState().status === "running") {
      this.updateWeChatState({ status: "stopped" });
    }
  }

  private async startWeChatPolling(): Promise<void> {
    const raw = this.weChatCredentialsJson();
    if (!raw) return;

    const credentials = parseCredentials(raw);
    if (!credentials) {
      this.updateWeChatState({ status: "stopped" });
      console.error("channel: invalid WECHAT_CREDENTIALS");
      return;
    }
    if (!isTrustedBaseUrl(credentials.baseUrl)) {
      // Keep the credential stored but expose the same visible state as an
      // expired session. Re-scanning replaces it; no token is ever sent to an
      // untrusted origin.
      this.updateWeChatState({ status: "expired", expiry_notified: 1 });
      console.warn("channel: WECHAT_CREDENTIALS_UNTRUSTED_BASE_URL");
      return;
    }

    const hash = await credentialsHash(raw);
    let state = this.readWeChatState();
    if (state.credentials_hash !== hash) {
      this.activeWeChatRun = null;
      this.db.exec("DELETE FROM wechat_contexts");
      this.updateWeChatState({
        credentials_hash: hash,
        cursor: null,
        status: "running",
        last_poll_at: null,
        expiry_notified: 0,
      });
      state = this.readWeChatState();
    }

    // Same credentials after a redeploy: resume a deliberate stop, but never
    // resurrect an expired session without new scanned credentials.
    if (state.status === "stopped") {
      this.updateWeChatState({ status: "running" });
      state = this.readWeChatState();
    }

    if (state.status !== "running") return;

    // Tests drive pollWeChat explicitly. Scheduling here would start a live
    // chain that can fire before the test installs its scripted fetch.
    if (getPollTimingOverride()?.manualStart) return;

    const now = Date.now();
    if (
      state.last_poll_at !== null &&
      now - state.last_poll_at < WECHAT_HEARTBEAT_MAX_AGE_MS
    ) {
      return;
    }

    const pending = await this.listSchedules();
    if (
      pending.some(
        (schedule) =>
          schedule.callback === "pollWeChat" && schedule.time * 1000 > now,
      )
    ) {
      return;
    }

    // Idempotent so a schedule(0) that is already due still counts as pending.
    await this.schedule(0, "pollWeChat", undefined, { idempotent: true });
  }

  async pollWeChat(
    _payload?: unknown,
    _schedule?: Schedule<unknown>,
  ): Promise<void> {
    const route = await this.currentRoute();
    if (route.channel !== "wechat") return;

    const raw = this.weChatCredentialsJson();
    const credentials = raw ? parseCredentials(raw) : null;
    const state = this.readWeChatState();
    if (!credentials || !raw || state.status !== "running" || !state.credentials_hash) return;
    if (this.activeWeChatRun) return;
    const run = { hash: state.credentials_hash, raw, routeKey: route.routeKey };
    this.activeWeChatRun = run;
    const ownsRun = async () => {
      const current = this.readWeChatState();
      return this.activeWeChatRun === run &&
        this.weChatCredentialsJson() === run.raw &&
        current.credentials_hash === run.hash && current.status === "running" &&
        (await this.currentRoute()).routeKey === run.routeKey;
    };

    try {
      const timing = getPollTimingOverride() ?? {
        runMs: WECHAT_POLL_RUN_MS,
        baseBackoffMs: WECHAT_POLL_BACKOFF_MS,
      };
      const client = createILinkClient({
        fetch: getILinkFetchOverride() ?? undefined,
      });
      const startedAt = Date.now();
      let backoffMs = timing.baseBackoffMs;

      do {
        if (!(await ownsRun())) return;
        const cursor = this.readWeChatState().cursor ?? "";
        // Refresh the heartbeat before the long poll so ensurePolling does not
        // start a second chain while getupdates is still waiting.
        this.updateWeChatState({ last_poll_at: Date.now() });

        try {
          const batch = await client.getUpdates(
            credentials,
            cursor,
            AbortSignal.timeout(WECHAT_GET_UPDATES_TIMEOUT_MS),
          );
          if (!(await ownsRun())) return;
          emitChannelEvent(this.env, {
            channel: "wechat",
            event: "poll_ok",
          });
          this.updateWeChatState({
            cursor: batch.cursor,
            last_poll_at: Date.now(),
          });
          this.dispatchWeChatUpdates(
            batch.updates,
            batch.cursor,
            credentials,
            run.routeKey,
          );
          backoffMs = timing.baseBackoffMs;
        } catch (error) {
          if (!(await ownsRun())) return;
          if (isSessionExpired(error)) {
            emitChannelEvent(this.env, {
              channel: "wechat",
              event: "poll_expired",
              errorCode: "session_expired",
            });
            await this.expireWeChat();
            return;
          }
          emitChannelEvent(this.env, {
            channel: "wechat",
            event: "poll_error",
            errorCode: wechatErrorCode(error),
          });
          console.error(
            `channel: wechat poll failed: ${errorMessage(error)}`,
          );
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, WECHAT_POLL_MAX_BACKOFF_MS);
        }
      } while (Date.now() - startedAt < timing.runMs);

      if (!(await ownsRun())) return;
      await this.schedule(0, "pollWeChat");
    } finally {
      if (this.activeWeChatRun === run) this.activeWeChatRun = null;
    }
  }

  private async expireWeChat(): Promise<void> {
    this.updateWeChatState({ status: "expired", expiry_notified: 1 });
    // Never notify through another channel; re-scan to obtain new credentials.
    console.warn("channel: wechat session expired, run the login script");
  }

  private dispatchWeChatUpdates(
    updates: WeChatUpdate[],
    cursor: string,
    credentials: WeChatCredentials,
    routeKey: string,
  ): void {
    updates.forEach((update, index) => {
      if (
        update.messageType !== 1 ||
        update.fromUserId !== credentials.userId
      ) {
        return;
      }

      if (update.contextToken) {
        this.db.exec(
          `INSERT INTO wechat_contexts (user_id, context_token, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             context_token = excluded.context_token,
             updated_at = excluded.updated_at`,
          update.fromUserId,
          update.contextToken,
          Date.now(),
        );
      }

      const eventId = `wx:${update.messageId ?? `${cursor}:${index}`}`;
      const event: MessageEvent = {
        type: "message",
        channel: "wechat",
        chatId: update.fromUserId,
        userId: update.fromUserId,
        text: update.text,
        eventId,
      };
      this.rememberOwner(event);

      // Deterministic owner commands replace the missing WeChat buttons.
      const textAction =
        update.text === null ? null : parseTextAction(update.text);
      if (textAction !== null) {
        this.dispatchWeChatAction(event, eventId, routeKey, textAction);
        return;
      }

      this.dispatchMessage(event, routeKey);
    });
  }

  private dispatchWeChatAction(
    event: MessageEvent,
    eventId: string,
    routeKey: string,
    parsed: TextAction,
  ): void {
    const action: ActionEvent = {
      type: "action",
      channel: "wechat",
      chatId: event.chatId,
      userId: event.userId,
      actionId: eventId,
      messageId: eventId,
      action: parsed.action,
      taskId: parsed.taskId,
      ...(parsed.approvalId === undefined
        ? {}
        : { approvalId: parsed.approvalId }),
      eventId,
    };

    this.ctx.waitUntil(
      this.handleWeChatAction(action, routeKey).catch((error: unknown) => {
        console.error(`channel: action failed: ${errorMessage(error)}`);
      }),
    );
  }

  private async handleWeChatAction(
    event: ActionEvent,
    routeKey: string,
  ): Promise<void> {
    if (!(await this.isAdmissionCurrent("wechat", routeKey))) return;

    let text = "出错了，稍后再试";
    try {
      const task = this.env.TASK.get(
        this.env.TASK.idFromName(event.taskId),
      );
      text = await task.handleAction(event);
    } catch (error) {
      console.error(`channel: action failed: ${errorMessage(error)}`);
    }

    if (!(await this.isAdmissionCurrent("wechat", routeKey))) return;
    await this.sendCurrent({ text });
  }

  private weChatCredentialsJson(): string | null {
    return getWeChatCredentialsOverride() ?? this.env.WECHAT_CREDENTIALS ?? null;
  }

  private parseWeChatCredentials(): WeChatCredentials | null {
    const raw = this.weChatCredentialsJson();
    return raw ? parseCredentials(raw) : null;
  }

  private readWeChatState(): WeChatState {
    return (
      this.db
        .exec<WeChatState>(
          `SELECT credentials_hash, cursor, status, last_poll_at,
                  expiry_notified
           FROM wechat_state LIMIT 1`,
        )
        .toArray()[0] ?? {
        credentials_hash: null,
        cursor: null,
        status: null,
        last_poll_at: null,
        expiry_notified: 0,
      }
    );
  }

  private updateWeChatState(patch: Partial<WeChatState>): void {
    const next = { ...this.readWeChatState(), ...patch };
    this.db.exec(
      `INSERT INTO wechat_state
         (credentials_hash, cursor, status, last_poll_at, expiry_notified)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM wechat_state)`,
      next.credentials_hash,
      next.cursor,
      next.status,
      next.last_poll_at,
      next.expiry_notified,
    );
    this.db.exec(
      `UPDATE wechat_state SET
         credentials_hash = ?,
         cursor = ?,
         status = ?,
         last_poll_at = ?,
         expiry_notified = ?`,
      next.credentials_hash,
      next.cursor,
      next.status,
      next.last_poll_at,
      next.expiry_notified,
    );
  }

  private wechatAdapter(): ChannelAdapter {
    const client = createILinkClient({
      fetch: getILinkFetchOverride() ?? undefined,
    });
    const hub = this;

    return {
      parseInbound: async () => null,
      send: async (chatId, msg) => {
        const credentials = hub.parseWeChatCredentials();
        if (!credentials) {
          throw new ChannelError("wechat not configured", 0);
        }

        const context = hub.db
          .exec<{ context_token: string }>(
            `SELECT context_token FROM wechat_contexts WHERE user_id = ?`,
            chatId,
          )
          .toArray()[0]?.context_token;
        if (!context) {
          throw new ChannelError("wechat context missing", 0);
        }

        if (msg.text.length === 0) return { messageId: "" };
        await client.sendText(credentials, chatId, context, msg.text);
        emitChannelEvent(hub.env, { channel: "wechat", event: "send_ok" });
        return { messageId: "" };
      },
      edit: async () => {},
      answerAction: async () => {},
    };
  }

  private dispatchMessage(event: MessageEvent, routeKey: string): void {
    try {
      const admitted: AdmittedMessage = { ...event, routeKey };
      const butler = this.env.BUTLER.get(
        this.env.BUTLER.idFromName("owner"),
      );
      // Telegram retries slow webhooks; acknowledge now and let the Butler run.
      this.ctx.waitUntil(
        butler.handleMessage(admitted).catch((error: unknown) => {
          console.error(
            `channel: message dispatch failed: ${errorMessage(error)}`,
          );
        }),
      );
    } catch (error) {
      console.error(
        `channel: message dispatch failed: ${errorMessage(error)}`,
      );
    }
  }

  private isOwner(event: InboundEvent): boolean {
    if (event.channel === "telegram") {
      return isOwner(readRuntimeConfig(this.env), Number(event.userId));
    }
    return this.parseWeChatCredentials()?.userId === event.userId;
  }

  private rememberOwner(event: InboundEvent): void {
    this.db.exec(
      `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         updated_at = excluded.updated_at`,
      event.channel,
      event.chatId,
      Date.now(),
    );
  }

  private adapter(channel: ChannelId): ChannelAdapter {
    const override = getChannelOverride(channel);
    if (override) return override;

    if (channel === "wechat") {
      return this.wechatAdapter();
    }

    this.telegramInstance ??= createTelegramAdapter({
      token: this.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: this.env.TELEGRAM_WEBHOOK_SECRET,
    });
    return this.telegramInstance;
  }
}
