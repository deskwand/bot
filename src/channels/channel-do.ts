import { Agent } from "agents";
import { config, isOwner } from "../config";
import {
  decodeAction,
  type ActionEvent,
  type Address,
  type ChannelId,
  type InboundEvent,
  type MessageEvent,
  type OutboundMessage,
} from "../protocol";
import { getChannelOverride } from "./override";
import { createTelegramAdapter } from "./telegram";
import { ChannelError, type ChannelAdapter } from "./types";

const ACTION_LABELS = {
  approve: "批准",
  reject: "拒绝",
  cancel: "取消",
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Drop buttons and turn each one into an instruction the owner can type. */
function forWechat(msg: OutboundMessage): OutboundMessage {
  if (!msg.buttons || msg.buttons.length === 0) return { text: msg.text };

  const hints: string[] = [];
  for (const row of msg.buttons) {
    for (const button of row) {
      const decoded = decodeAction(button.data);
      if (!decoded) continue;
      hints.push(
        `回复"${ACTION_LABELS[decoded.action]} ${decoded.taskId}"`,
      );
    }
  }

  return hints.length === 0
    ? { text: msg.text }
    : { text: `${msg.text}\n${hints.join("\n")}` };
}

/**
 * Single channel hub: the only place that talks to a channel API, and the only
 * place inbound channel events enter the control plane.
 */
export class ChannelDO extends Agent<Env> {
  private readonly db: SqlStorage;

  private telegramInstance: ChannelAdapter | undefined;

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

  async handleTelegramWebhook(req: Request): Promise<void> {
    try {
      const adapter = this.adapter("telegram");

      let event: InboundEvent | null;
      try {
        event = await adapter.parseInbound(req);
      } catch (error) {
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

      if (event.type === "message") {
        this.dispatchMessage(event);
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

  async send(
    to: Address | "notify",
    msg: OutboundMessage,
  ): Promise<{ messageId: string | null }> {
    const address = this.resolveAddress(to);
    const adapter = this.adapter(address.channel);
    const outbound =
      address.channel === "wechat" ? forWechat(msg) : msg;
    const sent = await adapter.send(address.conversationId, outbound);
    return { messageId: sent.messageId || null };
  }

  async edit(
    to: Address | "notify",
    messageId: string,
    msg: OutboundMessage,
  ): Promise<boolean> {
    const address = this.resolveAddress(to);
    if (address.channel === "wechat") return false;

    await this.adapter("telegram").edit(
      address.conversationId,
      messageId,
      msg,
    );
    return true;
  }

  async ensurePolling(): Promise<void> {
    // WeChat polling starts in a later task.
  }

  private dispatchMessage(event: MessageEvent): void {
    try {
      const butler = this.env.BUTLER.get(
        this.env.BUTLER.idFromName("owner"),
      );
      // Telegram retries slow webhooks; acknowledge now and let the Butler run.
      this.ctx.waitUntil(
        butler.handleMessage(event).catch((error: unknown) => {
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
      return isOwner(config, Number(event.userId));
    }
    // WeChat uses the logged-in user's id once the channel is configured.
    return false;
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

  private resolveAddress(to: Address | "notify"): Address {
    if (to !== "notify") return to;

    const row = this.db
      .exec<{ conversation_id: string }>(
        `SELECT conversation_id FROM owner_addresses WHERE channel = ?`,
        config.notifyChannel,
      )
      .toArray()[0];
    if (row) {
      return {
        channel: config.notifyChannel,
        conversationId: row.conversation_id,
      };
    }

    const fallback = config.owner.telegramUserIds[0];
    if (fallback !== undefined) {
      return { channel: "telegram", conversationId: String(fallback) };
    }

    throw new ChannelError("no notify address", 0);
  }

  private adapter(channel: ChannelId): ChannelAdapter {
    const override = getChannelOverride(channel);
    if (override) return override;

    if (channel === "wechat") {
      throw new ChannelError("wechat not configured", 0);
    }

    this.telegramInstance ??= createTelegramAdapter({
      token: this.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: this.env.TELEGRAM_WEBHOOK_SECRET,
    });
    return this.telegramInstance;
  }
}
