import { Agent, type Schedule } from "agents";
import { BackupRpc } from "../admin/backup-rpc";
import { DEFER_MS, MaintenanceStore, type Lease } from "../admin/maintenance";
import type {
  DbSchema,
  DumpPage,
  DumpRow,
  TableSchema,
} from "../admin/sql-dump";
import { MAX_ARTIFACT_BYTES, artifactKeySegments, artifactNameFromKey } from "../artifact";
import { actionHint } from "../butler/owner-copy";
import { isOwner } from "../config";
import { ownerLocale, t, type Locale } from "../i18n";
import { readRuntimeConfig } from "../runtime-config";
import { classifyFile, extensionForMime } from "../tools/file-content";
import {
  decodeAction,
  type ActionEvent,
  type AdmittedMessage,
  type ChannelId,
  type ChannelMessageRef,
  type InboundEvent,
  type InboundFile,
  type MessageEvent,
  type OutboundMessage,
  type RouteSnapshot,
} from "../protocol";
import {
  getChannelOverride,
  getILinkFetchOverride,
  getPollTimingOverride,
  getTelegramFetchOverride,
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
import { inboxStore } from "./inbox";
import { OutboundQueue } from "./outbound-queue";
import { describeImageBytes, prepareInboundImage, sniffImageType } from "./media";
import { createTelegramAdapter } from "./telegram";
import {
  createTelegramPollClient,
  type TelegramUpdateBatch,
} from "./telegram-poll";
import { parseTextAction, textHint, type TextAction } from "./text-action";
import { ChannelError, type ChannelAdapter, type OutboundArtifact } from "./types";
import { withRetry } from "./retry";
import { toWeChatText } from "./wechat/markdown";
import {
  createILinkClient,
  ILinkError,
  isSessionExpired,
  isTrustedBaseUrl,
  parseCredentials,
  type WeChatCredentials,
  type WeChatFileRef,
  type WeChatUpdate,
} from "./wechat/ilink";
import type { WeChatImageRef } from "./wechat/media";

// One long poll per alarm, then a hand-off to the next alarm. A long run in
// one alarm survives a deploy on the superseded isolate: observed in production,
// the old run stalled for minutes before the platform reset it, and no poll ran
// meanwhile. A short alarm lets the next poll start on the new code.
const WECHAT_POLL_RUN_MS = 0;
const WECHAT_POLL_BACKOFF_MS = 1_000;
const WECHAT_POLL_MAX_BACKOFF_MS = 10_000;
const WECHAT_GET_UPDATES_TIMEOUT_MS = 40_000;
// Skip the pre-poll heartbeat while it is fresh: the write after the previous
// long poll is enough to keep ensurePolling from starting a second chain.
const WECHAT_PREPOLL_HEARTBEAT_MS = 20_000;
// One long poll (40s) plus a skipped pre-poll write (20s) plus the longest
// backoff (10s) stays under this, so a live chain is never doubled, and a dead
// one is revived by the per-minute Cron within about 75s plus one Cron tick.
const WECHAT_HEARTBEAT_MAX_AGE_MS = 75_000;
const TELEGRAM_POLL_RUN_MS = 0;
const TELEGRAM_POLL_BACKOFF_MS = 1_000;
const TELEGRAM_POLL_MAX_BACKOFF_MS = 10_000;
const TELEGRAM_GET_UPDATES_TIMEOUT_MS = 35_000;
const TELEGRAM_HEARTBEAT_MAX_AGE_MS = 60_000;
/** How many drains a rejected message survives before it is given up on. */
const OUTBOUND_MAX_ATTEMPTS = 5;
type WeChatState = {
  credentials_hash: string | null;
  cursor: string | null;
  status: string | null;
  last_poll_at: number | null;
  expiry_notified: number;
};
type TelegramState = {
  token_hash: string | null;
  offset: number;
  status: string | null;
  last_poll_at: number | null;
  expired_version: string | null;
};
type TelegramPollClient = ReturnType<typeof createTelegramPollClient>;
type TelegramWebhookRetry = {
  attempted: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function credentialsHash(json: string): Promise<string> {
  return sha256Hex(json);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function channelDisabledText(locale: Locale): string {
  return t(locale, "channel.disabled");
}

export function channelErrorText(locale: Locale): string {
  return t(locale, "channel.error");
}

/**
 * Maps an iLink/Telegram/network failure to a fixed diagnostic code. The raw
 * error text is never logged as an event field.
 */
function channelErrorCode(error: unknown): string {
  // Only iLink uses status 0 to mean an untrusted origin. A status-0
  // `ChannelError` maps to `network_error` below, as it did before.
  if (error instanceof ILinkError && error.status === 0) {
    return "untrusted_origin";
  }
  if (error instanceof ILinkError || error instanceof ChannelError) {
    if (error.status === 429) return "rate_limited";
    if (error.status >= 500) return "upstream_error";
    if (error.status !== 0) return "api_error";
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
function forWechat(msg: OutboundMessage, locale: Locale): OutboundMessage {
  const text = toWeChatText(msg.text);
  if (!msg.buttons || msg.buttons.length === 0) return { text };

  const hints: string[] = [];
  for (const row of msg.buttons) {
    for (const button of row) {
      // The sender knows the display handle, which the encoded data cannot.
      if (button.hint !== undefined) {
        hints.push(textHint(locale, button.hint));
        continue;
      }
      const decoded = decodeAction(button.data);
      if (!decoded) continue;
      hints.push(
        textHint(
          locale,
          actionHint(locale, decoded.action, {
            taskId: decoded.taskId,
            ...(decoded.approvalId === undefined
              ? {}
              : { approvalId: decoded.approvalId }),
          }),
        ),
      );
    }
  }

  return hints.length === 0
    ? { text }
    : { text: `${text}\n${hints.join("\n")}` };
}

/** Replaces a whole `t<n>` id, so `t7` is not rewritten inside `t70`. */
function replaceTaskId(text: string, taskId: string, label: string): string {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\b${escaped}\\b`, "g"), label);
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

  private activeTelegramRun: {
    token: string;
    hash: string;
    routeKey: string;
  } | null = null;

  /**
   * Error backoff carried across alarms: each alarm makes one poll, so the
   * doubling would otherwise restart at the base delay every time.
   */
  private weChatBackoffMs: number | null = null;

  private telegramBackoffMs: number | null = null;
  /** Cached for the lifetime of this instance: its environment is immutable. */
  private routePromise: Promise<RouteSnapshot> | undefined;

  private readonly lease: MaintenanceStore;

  private readonly backup: BackupRpc;

  private readonly outbound: OutboundQueue;

  /** Single-flight guard: an inbound drain and a send-time drain must not run twice. */
  private outboundFlush: Promise<void> | null = null;

  /** A row was added while a drain was running, so one more pass is due. */
  private outboundAgain = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;
    this.outbound = new OutboundQueue(this.db);
    this.lease = new MaintenanceStore(this.db);
    this.backup = new BackupRpc(ctx, this.lease);

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
      `CREATE TABLE IF NOT EXISTS telegram_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token_hash TEXT,
        offset INTEGER,
        status TEXT,
        last_poll_at INTEGER,
        expired_version TEXT
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

  async handleTelegramUpdate(
    update: unknown,
  ): Promise<"accepted" | "maintenance"> {
    if (this.lease.current() !== null) return "maintenance";

    try {
      const adapter = this.adapter("telegram");

      let event: InboundEvent | null;
      try {
        event = await adapter.parseInbound(update);
      } catch (error) {
        emitChannelEvent(this.env, {
          channel: "telegram",
          event: "webhook_rejected",
          errorCode: "payload_invalid",
        });
        console.error(
          `channel: failed to parse update: ${errorMessage(error)}`,
        );
        return "accepted";
      }
      if (!event) return "accepted";

      if (!this.isOwner(event)) {
        console.warn(`channel: ignoring event from non-owner ${event.userId}`);
        return "accepted";
      }

      this.rememberOwner(event);

      // The other channel's input must not reach the Butler or a task.
      const route = await this.currentRoute();
      if (route.channel !== "telegram") {
        if (event.type === "action") {
          try {
            await adapter.answerAction(
              event.actionId,
              channelDisabledText(ownerLocale(this.env)),
            );
          } catch (error) {
            console.error(
              `channel: answer callback failed: ${errorMessage(error)}`,
            );
          }
        }
        return "accepted";
      }

      if (event.type === "message") {
        if (this.dispatchMessage(event, route.routeKey)) return "accepted";
        // A false result without a lease is a dispatch exception (already
        // logged); only a live lease asks the poller to replay the update.
        return this.lease.current() === null ? "accepted" : "maintenance";
      }

      let text = channelErrorText(ownerLocale(this.env));
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
      // The update must always be acknowledged, even for an unexpected bug.
      console.error(`channel: telegram update failed: ${errorMessage(error)}`);
    }
    return "accepted";
  }

  /**
   * Lease RPCs. A live lease pauses inbound webhooks, polling and alarms; the
   * admin gateway keeps it alive on both this hub and the Butler.
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

  /**
   * 发送一个产物。产物不进 outbound 队列：15MB 的对象既不该进队列行，
   * 也不该把"文本能不能及时送达"绑在"这个文件能不能传上去"上。
   */
  async sendArtifact(key: string): Promise<void> {
    const route = await this.currentRoute();
    if (route.channel === null) {
      throw new ChannelError("channel selection disabled", 0);
    }
    if (artifactKeySegments(key) === null) {
      throw new ChannelError("invalid artifact key", 400);
    }

    const object = await this.env.ARTIFACTS.get(key);
    if (!object) throw new ChannelError("artifact missing", 404);
    if (object.size > MAX_ARTIFACT_BYTES) {
      throw new ChannelError("artifact too large", 413);
    }

    const channel = route.channel;
    const file: OutboundArtifact = {
      name: artifactNameFromKey(key),
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      bytes: await object.arrayBuffer(),
    };

    try {
      await withRetry(async () => {
        await this.adapter(channel).sendArtifact(
          this.currentAddress(channel),
          file,
        );
      });
      emitChannelEvent(this.env, { channel, event: "send_ok" });
    } catch (error) {
      emitChannelEvent(this.env, {
        channel,
        event: "send_error",
        errorCode: channelErrorCode(error),
      });
      throw error;
    }
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
    const outbound =
      channel === "wechat" ? forWechat(msg, ownerLocale(this.env)) : msg;

    if (channel !== "wechat") {
      const sent = await this.adapter(channel).send(conversationId, outbound);
      emitChannelEvent(this.env, { channel: "telegram", event: "send_ok" });
      return {
        channel,
        conversationId,
        routeKey,
        messageId: sent.messageId || null,
      };
    }

    // WeChat has no message ids and no retry of its own, so the message is
    // written down before anything talks to the network: a failure anywhere
    // after this point leaves a row behind instead of losing the message.
    // Only `drainOutbound` sends, and it goes in queue order, so a message
    // added here waits behind older ones and is delivered at least once.
    const { dropped } = this.outbound.enqueue({
      conversationId,
      text: outbound.text,
      buttons: outbound.buttons ?? null,
    });
    if (dropped > 0) {
      console.error(`channel: outbound queue dropped ${dropped} oldest rows`);
    }
    await this.flushOutbound();
    return { channel, conversationId, routeKey, messageId: null };
  }

  /** Sends queued messages, oldest first. */
  async flushOutbound(): Promise<void> {
    if (this.outboundFlush !== null) {
      // A row may be added while the running drain is listing them: ask for
      // one more pass instead of leaving it for the next caller.
      this.outboundAgain = true;
      await this.outboundFlush;
      return;
    }
    this.outboundFlush = this.drainOutbound().finally(() => {
      this.outboundFlush = null;
    });
    await this.outboundFlush;
    if (this.outboundAgain) {
      this.outboundAgain = false;
      await this.flushOutbound();
    }
  }

  private async drainOutbound(): Promise<void> {
    if ((await this.currentRoute()).channel !== "wechat") return;
    let address: string;
    try {
      address = this.currentAddress("wechat");
    } catch {
      // No owner address yet: the rows wait for the first inbound message.
      return;
    }
    const adapter = this.adapter("wechat");

    for (const row of this.outbound.list()) {
      // A row for another conversation belongs to a former account (the chat
      // id changes with the credentials) and can never be delivered.
      if (row.conversationId !== address) {
        this.outbound.remove(row.id);
        console.error("channel: dropped a queued message for a former account");
        continue;
      }
      // One message the channel always rejects must not wedge the queue.
      if (row.attempts >= OUTBOUND_MAX_ATTEMPTS) {
        this.outbound.remove(row.id);
        console.error(
          `channel: gave up on a queued message after ${row.attempts} attempts`,
        );
        emitChannelEvent(this.env, {
          channel: "wechat",
          event: "send_error",
          errorCode: row.lastError ?? "api_error",
        });
        continue;
      }
      try {
        await adapter.send(row.conversationId, {
          text: row.text,
          ...(row.buttons === null ? {} : { buttons: row.buttons }),
        });
        this.outbound.remove(row.id);
      } catch (error) {
        // Order matters: later messages wait behind this one.
        this.reportSendFailure(row.id, error);
        return;
      }
    }
  }

  /** Records a rejected send as a sanitized event and keeps the row. */
  private reportSendFailure(id: number, error: unknown): void {
    const code = channelErrorCode(error);
    this.outbound.markError(id, code);
    emitChannelEvent(this.env, {
      channel: "wechat",
      event: "send_error",
      errorCode: code,
    });
    console.error(`channel: wechat send failed: ${errorMessage(error)}`);
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
    if (this.lease.current() !== null) return;

    const route = await this.currentRoute();

    if (route.channel === "telegram") {
      await this.stopWeChatPolling();
      await this.startTelegramPolling();
      return;
    }

    if (route.channel === "wechat") {
      await this.stopTelegramPolling();
      await this.startWeChatPolling();
      return;
    }

    await this.stopWeChatPolling();
    await this.stopTelegramPolling();
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

  /** Stops the Telegram chain without discarding the offset. */
  private async stopTelegramPolling(): Promise<void> {
    this.activeTelegramRun = null;

    for (const schedule of await this.listSchedules()) {
      if (schedule.callback === "pollTelegram") {
        await this.cancelSchedule(schedule.id);
      }
    }

    // A deliberate deactivation is not an expiry: keep the offset so selecting
    // Telegram again resumes where it left off.
    if (this.readTelegramState().status === "running") {
      this.updateTelegramState({ status: "stopped" });
    }
  }

  private async startTelegramPolling(): Promise<void> {
    const token = this.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;

    const hash = await sha256Hex(token);
    let state = this.readTelegramState();
    if (state.token_hash !== hash) {
      // New or replaced token: a former expiry no longer applies.
      this.activeTelegramRun = null;
      this.updateTelegramState({
        token_hash: hash,
        offset: 0,
        status: "running",
        last_poll_at: null,
        expired_version: null,
      });
      state = this.readTelegramState();
    }

    // Same token after a redeploy: resume a deliberate stop, but never
    // resurrect an expired token without new credentials.
    if (state.status === "stopped") {
      this.updateTelegramState({ status: "running" });
      state = this.readTelegramState();
    }

    // A rejected token is retried once after a redeploy. The same version
    // stays expired so a bad token does not poll in a loop.
    const versionId = this.env.CF_VERSION_METADATA?.id ?? "";
    if (state.status === "expired" && state.expired_version !== versionId) {
      this.updateTelegramState({
        status: "running",
        expired_version: null,
      });
      state = this.readTelegramState();
    }

    if (state.status !== "running") return;

    // Tests drive pollTelegram explicitly. Scheduling here would start a live
    // chain that can fire before the test installs its scripted fetch.
    if (getPollTimingOverride()?.manualStart) return;

    const now = Date.now();
    if (
      state.last_poll_at !== null &&
      now - state.last_poll_at < TELEGRAM_HEARTBEAT_MAX_AGE_MS
    ) {
      return;
    }

    const pending = await this.listSchedules();
    if (
      pending.some(
        (schedule) =>
          schedule.callback === "pollTelegram" && schedule.time * 1000 > now,
      )
    ) {
      return;
    }

    // Idempotent so a schedule(0) that is already due still counts as pending.
    await this.schedule(0, "pollTelegram", undefined, { idempotent: true });
  }

  /**
   * One long-poll step. A 409 means an older deployment still has a webhook
   * registered: remove it without `drop_pending_updates` (the backlog is kept)
   * and retry once.
   */
  private async fetchTelegramBatch(
    client: TelegramPollClient,
    offset: number,
    ownsRun: () => Promise<boolean>,
    retry: TelegramWebhookRetry,
  ): Promise<TelegramUpdateBatch | "stopped"> {
    try {
      return await client.getUpdates(
        offset,
        AbortSignal.timeout(TELEGRAM_GET_UPDATES_TIMEOUT_MS),
      );
    } catch (error) {
      if (
        !(error instanceof ChannelError) ||
        error.status !== 409 ||
        retry.attempted
      ) {
        throw error;
      }

      retry.attempted = true;
      await client.deleteWebhook(
        AbortSignal.timeout(TELEGRAM_GET_UPDATES_TIMEOUT_MS),
      );

      if (!(await ownsRun())) return "stopped";
      this.updateTelegramState({ last_poll_at: Date.now() });
      return await client.getUpdates(
        offset,
        AbortSignal.timeout(TELEGRAM_GET_UPDATES_TIMEOUT_MS),
      );
    }
  }

  async pollTelegram(
    _payload?: unknown,
    _schedule?: Schedule<unknown>,
  ): Promise<void> {
    if (this.lease.current() !== null) return;

    const route = await this.currentRoute();
    if (route.channel !== "telegram") return;

    const token = this.env.TELEGRAM_BOT_TOKEN;
    const state = this.readTelegramState();
    if (!token || state.status !== "running" || !state.token_hash) return;
    if (this.activeTelegramRun) return;
    const run = { token, hash: state.token_hash, routeKey: route.routeKey };
    this.activeTelegramRun = run;
    const ownsRun = async () => {
      const current = this.readTelegramState();
      return this.activeTelegramRun === run &&
        this.lease.current() === null &&
        this.env.TELEGRAM_BOT_TOKEN === run.token &&
        current.token_hash === run.hash && current.status === "running" &&
        (await this.currentRoute()).routeKey === run.routeKey;
    };

    try {
      const timing = getPollTimingOverride() ?? {
        runMs: TELEGRAM_POLL_RUN_MS,
        baseBackoffMs: TELEGRAM_POLL_BACKOFF_MS,
      };
      const client = createTelegramPollClient({
        token,
        fetch: getTelegramFetchOverride() ?? undefined,
      });
      const startedAt = Date.now();
      const retry: TelegramWebhookRetry = { attempted: false };

      do {
        if (!(await ownsRun())) return;
        // Refresh the heartbeat before the long poll so ensurePolling does not
        // start a second chain while getUpdates is still waiting.
        this.updateTelegramState({ last_poll_at: Date.now() });

        let batch: TelegramUpdateBatch;
        try {
          const fetched = await this.fetchTelegramBatch(
            client,
            this.readTelegramState().offset,
            ownsRun,
            retry,
          );
          if (fetched === "stopped") return;
          batch = fetched;
        } catch (error) {
          if (!(await ownsRun())) return;
          if (
            error instanceof ChannelError &&
            (error.status === 401 || error.status === 404)
          ) {
            emitChannelEvent(this.env, {
              channel: "telegram",
              event: "poll_expired",
              errorCode: "credential_invalid",
            });
            this.updateTelegramState({
              status: "expired",
              expired_version: this.env.CF_VERSION_METADATA?.id ?? "",
            });
            console.warn("channel: telegram token invalid, polling stopped");
            return;
          }
          emitChannelEvent(this.env, {
            channel: "telegram",
            event: "poll_error",
            errorCode: channelErrorCode(error),
          });
          console.error(
            `channel: telegram poll failed: ${errorMessage(error)}`,
          );
          const backoffMs = this.telegramBackoffMs ?? timing.baseBackoffMs;
          await sleep(backoffMs);
          this.telegramBackoffMs = Math.min(
            backoffMs * 2,
            TELEGRAM_POLL_MAX_BACKOFF_MS,
          );
          continue;
        }

        retry.attempted = false;
        if (!(await ownsRun())) return;
        emitChannelEvent(this.env, {
          channel: "telegram",
          event: "poll_ok",
        });
        this.updateTelegramState({ last_poll_at: Date.now() });

        for (const update of batch.updates) {
          if (!(await ownsRun())) return;
          const outcome = await this.handleTelegramUpdate(update);
          // The lease landed mid-batch: keep this update's offset so the Cron
          // replays it after the restore releases the lease.
          if (outcome === "maintenance") return;
          this.updateTelegramState({ offset: update.update_id + 1 });
        }
        this.telegramBackoffMs = null;
      } while (Date.now() - startedAt < timing.runMs);

      if (!(await ownsRun())) return;
      await this.schedule(0, "pollTelegram");
    } finally {
      if (this.activeTelegramRun === run) this.activeTelegramRun = null;
    }
  }

  async pollWeChat(
    _payload?: unknown,
    _schedule?: Schedule<unknown>,
  ): Promise<void> {
    if (this.lease.current() !== null) return;

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
        this.lease.current() === null &&
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

      do {
        if (!(await ownsRun())) return;
        const cursor = this.readWeChatState().cursor ?? "";
        // Refresh the heartbeat before the long poll only when the previous
        // one is stale, so ensurePolling does not start a second chain while
        // getupdates is still waiting. A fresh heartbeat already does that.
        const lastPollAt = this.readWeChatState().last_poll_at;
        if (
          lastPollAt === null ||
          Date.now() - lastPollAt > WECHAT_PREPOLL_HEARTBEAT_MS
        ) {
          this.updateWeChatState({ last_poll_at: Date.now() });
        }

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
          this.weChatBackoffMs = null;
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
            errorCode: channelErrorCode(error),
          });
          console.error(
            `channel: wechat poll failed: ${errorMessage(error)}`,
          );
          const backoffMs = this.weChatBackoffMs ?? timing.baseBackoffMs;
          await sleep(backoffMs);
          this.weChatBackoffMs = Math.min(
            backoffMs * 2,
            WECHAT_POLL_MAX_BACKOFF_MS,
          );
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
    // A lease can be acquired while getUpdates is in flight. Do not admit the
    // batch or write session context into a database that is being restored.
    if (this.lease.current() !== null) return;
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
        // The token just refreshed; anything the channel rejected earlier can
        // go out now.
        this.ctx.waitUntil(
          this.flushOutbound().catch((error: unknown) => {
            console.error(
              `channel: outbound flush failed: ${errorMessage(error)}`,
            );
          }),
        );
      }

      const eventId = `wx:${update.messageId ?? `${cursor}:${index}`}`;
      const event: MessageEvent = {
        type: "message",
        channel: "wechat",
        chatId: update.fromUserId,
        userId: update.fromUserId,
        text: update.text,
        ...(update.voice && !update.text ? { voiceFailed: true } : {}),
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

      if (update.image) {
        this.ctx.waitUntil(this.dispatchWeChatImage(event, update.image, routeKey));
        return;
      }

      if (update.file) {
        this.ctx.waitUntil(this.dispatchWeChatFile(event, update.file, routeKey));
        return;
      }

      this.dispatchMessage(event, routeKey);
    });
  }

  /**
   * WeChat hands over an image as an encrypted CDN object. Downloading and
   * decrypting it happens off the poll loop, so one slow image does not hold
   * the rest of the batch.
   */
  private async dispatchWeChatImage(
    event: MessageEvent,
    image: WeChatImageRef,
    routeKey: string,
  ): Promise<void> {
    const client = createILinkClient({
      fetch: getILinkFetchOverride() ?? undefined,
    });
    const bytes = await client.downloadImage(image);
    if (!bytes) {
      console.warn(`channel: wechat image download failed (${event.eventId})`);
      this.dispatchMessage({ ...event, imageFailed: true }, routeKey);
      return;
    }

    const prepared = await prepareInboundImage(bytes);
    if (!prepared.ok) {
      // The CDN answers 200 even when the body is not the image the item
      // promised, so name what arrived: key present, header bytes, format.
      const key = image.aesKeyHex
        ? "hex"
        : image.mediaAesKey
          ? "base64"
          : "none";
      const detail =
        prepared.detail === undefined
          ? ""
          : ` detail=${prepared.detail.slice(0, 120)}`;
      console.warn(
        `channel: wechat image unusable (${event.eventId})` +
          ` reason=${prepared.reason} key=${key} ${describeImageBytes(bytes)}${detail}`,
      );
      this.dispatchMessage({ ...event, imageFailed: true }, routeKey);
      return;
    }

    const files: InboundFile[] = [];
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      // The inbox copy is a convenience and the model image is prepared from
      // the same bytes; an oversized original just skips the copy.
      console.warn(
        `channel: wechat image not stored in inbox (${event.eventId}):` +
          ` larger than ${MAX_ARTIFACT_BYTES} bytes`,
      );
    } else {
      try {
        const mimeType = sniffImageType(bytes) ?? prepared.image.mimeType;
        const extension = extensionForMime(mimeType) ?? "jpg";
        files.push(
          await inboxStore(this.env.ARTIFACTS)(
            event.eventId,
            `image.${extension}`,
            bytes,
            mimeType,
          ),
        );
      } catch (error) {
        // The inbox copy is a convenience; the image itself still reaches the
        // butler even when R2 refuses the write.
        console.error(
          `channel: wechat inbox store failed (${event.eventId}): ${errorMessage(error)}`,
        );
      }
    }

    this.dispatchMessage(
      { ...event, images: [prepared.image], ...(files.length > 0 ? { files } : {}) },
      routeKey,
    );
  }

  /**
   * WeChat hands files over as encrypted CDN objects too. The butler only gets
   * the inbox reference, so a large download never enters the message event.
   */
  private async dispatchWeChatFile(
    event: MessageEvent,
    file: WeChatFileRef,
    routeKey: string,
  ): Promise<void> {
    if (file.size !== undefined && file.size > MAX_ARTIFACT_BYTES) {
      this.dispatchMessage({ ...event, fileFailed: "too_large" }, routeKey);
      return;
    }

    const client = createILinkClient({
      fetch: getILinkFetchOverride() ?? undefined,
    });
    const bytes = await client.downloadFile(file);
    if (!bytes) {
      console.warn(`channel: wechat file download failed (${event.eventId})`);
      this.dispatchMessage({ ...event, fileFailed: "download" }, routeKey);
      return;
    }
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      this.dispatchMessage({ ...event, fileFailed: "too_large" }, routeKey);
      return;
    }

    const { mimeType } = classifyFile(bytes, "", file.name);
    try {
      const stored = await inboxStore(this.env.ARTIFACTS)(
        event.eventId,
        file.name,
        bytes,
        mimeType,
      );
      this.dispatchMessage({ ...event, files: [stored] }, routeKey);
    } catch (error) {
      console.error(
        `channel: wechat inbox store failed (${event.eventId}): ${errorMessage(error)}`,
      );
      this.dispatchMessage({ ...event, fileFailed: "download" }, routeKey);
    }
  }

  private dispatchWeChatAction(
    event: MessageEvent,
    eventId: string,
    routeKey: string,
    parsed: TextAction,
  ): void {
    this.ctx.waitUntil(
      this.handleWeChatAction(event, eventId, routeKey, parsed).catch(
        (error: unknown) => {
          console.error(`channel: action failed: ${errorMessage(error)}`);
        },
      ),
    );
  }

  private async handleWeChatAction(
    event: MessageEvent,
    eventId: string,
    routeKey: string,
    parsed: TextAction,
  ): Promise<void> {
    if (!(await this.isAdmissionCurrent("wechat", routeKey))) return;

    // The legacy `t<n>` form needs no lookup: the id is already the target.
    let target: { taskId: string; label: string; approvalId?: string } | null =
      parsed.target.kind === "taskId"
        ? {
            taskId: parsed.target.taskId,
            label: parsed.target.taskId,
            ...(parsed.approvalId === undefined
              ? {}
              : { approvalId: parsed.approvalId }),
          }
        : null;

    if (target === null) {
      try {
        const butler = this.env.BUTLER.get(
          this.env.BUTLER.idFromName("owner"),
        );
        const resolution = await butler.resolveTextAction(parsed);
        if (resolution.kind === "chat") {
          // The Butler already had its round trip, so a later message in this
          // batch may reach it first. Best-effort ordering is acceptable here.
          this.dispatchMessage(event, routeKey);
          return;
        }
        if (resolution.kind === "reply") {
          if (!(await this.isAdmissionCurrent("wechat", routeKey))) return;
          await this.sendCurrent({ text: resolution.text });
          return;
        }
        target = {
          taskId: resolution.taskId,
          label: resolution.label,
          ...(resolution.approvalId === undefined
            ? {}
            : { approvalId: resolution.approvalId }),
        };
      } catch (error) {
        console.error(
          `channel: action resolution failed: ${errorMessage(error)}`,
        );
        if (!(await this.isAdmissionCurrent("wechat", routeKey))) return;
        await this.sendCurrent({
          text: channelErrorText(ownerLocale(this.env)),
        });
        return;
      }
    }

    let text = channelErrorText(ownerLocale(this.env));
    try {
      const action: ActionEvent = {
        type: "action",
        channel: "wechat",
        chatId: event.chatId,
        userId: event.userId,
        actionId: eventId,
        messageId: eventId,
        action: parsed.action,
        taskId: target.taskId,
        ...(target.approvalId === undefined
          ? {}
          : { approvalId: target.approvalId }),
        eventId,
      };
      const task = this.env.TASK.get(
        this.env.TASK.idFromName(action.taskId),
      );
      text = await task.handleAction(action);
      if (target.label !== target.taskId) {
        text = replaceTaskId(text, target.taskId, target.label);
      }
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

  private readTelegramState(): TelegramState {
    return (
      this.db
        .exec<TelegramState>(
          `SELECT token_hash, offset, status, last_poll_at, expired_version
           FROM telegram_state WHERE id = 1`,
        )
        .toArray()[0] ?? {
        token_hash: null,
        offset: 0,
        status: null,
        last_poll_at: null,
        expired_version: null,
      }
    );
  }

  /** Upserts the single row, writing only the columns the patch names. */
  private updateTelegramState(patch: Partial<TelegramState>): void {
    const columns = [
      "token_hash",
      "offset",
      "status",
      "last_poll_at",
      "expired_version",
    ] as const;
    const changed = columns.filter((key) => patch[key] !== undefined);
    if (changed.length === 0) return;

    const next: TelegramState = {
      token_hash: null,
      offset: 0,
      status: null,
      last_poll_at: null,
      expired_version: null,
      ...patch,
    };
    this.db.exec(
      `INSERT INTO telegram_state (id, ${columns.join(", ")})
       VALUES (1, ${columns.map(() => "?").join(", ")})
       ON CONFLICT(id) DO UPDATE SET ${changed
         .map((key) => `${key} = excluded.${key}`)
         .join(", ")}`,
      ...columns.map((key) => next[key]),
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
      sendArtifact: async (chatId, file) => {
        const credentials = hub.parseWeChatCredentials();
        if (!credentials) throw new ChannelError("wechat not configured", 0);

        const context = hub.db
          .exec<{ context_token: string }>(
            `SELECT context_token FROM wechat_contexts WHERE user_id = ?`,
            chatId,
          )
          .toArray()[0]?.context_token;
        if (!context) throw new ChannelError("wechat context missing", 0);

        await client.sendMedia(credentials, chatId, context, file);
        emitChannelEvent(hub.env, { channel: "wechat", event: "send_ok" });
      },
      edit: async () => {},
      answerAction: async () => {},
    };
  }

  private dispatchMessage(event: MessageEvent, routeKey: string): boolean {
    // Fail closed for a poll or webhook already in flight when the lease was
    // acquired: the Butler must not start new work against half-saved data.
    if (this.lease.current() !== null) return false;
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
      return true;
    } catch (error) {
      console.error(
        `channel: message dispatch failed: ${errorMessage(error)}`,
      );
      return false;
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
      ai: this.env.AI,
      storeFile: inboxStore(this.env.ARTIFACTS),
    });
    return this.telegramInstance;
  }
}
