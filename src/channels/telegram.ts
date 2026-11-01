import {
  decodeAction,
  type ActionEvent,
  type Button,
  type InboundEvent,
  type MessageEvent,
  type OutboundMessage,
} from "../protocol";
import { renderForTelegram } from "./telegram-render";
import { ChannelError, type ChannelAdapter } from "./types";

const API_BASE = "https://api.telegram.org";

type TelegramUser = { id: number };
type TelegramChat = { id: number };
type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
};
type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};
type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramResponse = {
  ok: boolean;
  description?: string;
  result?: { message_id?: number };
};

export type TelegramAdapterOptions = {
  token?: string;
  webhookSecret?: string;
  fetch?: typeof fetch;
};

function toKeyboard(buttons: Button[][]) {
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) => ({
        text: button.label,
        callback_data: button.data,
      })),
    ),
  };
}

export function createTelegramAdapter(
  opts: TelegramAdapterOptions,
): ChannelAdapter {
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  async function call(
    method: string,
    body: Record<string, unknown>,
  ): Promise<TelegramResponse> {
    if (!opts.token) {
      throw new ChannelError("telegram not configured", 0);
    }

    const response = await fetchImpl(
      `${API_BASE}/bot${opts.token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    let json: TelegramResponse | null = null;
    try {
      json = (await response.json()) as TelegramResponse;
    } catch {
      json = null;
    }

    if (!response.ok || json === null || json.ok !== true) {
      throw new ChannelError(
        json?.description ?? `Telegram ${method} failed (${response.status})`,
        response.status,
      );
    }

    return json;
  }

  /**
   * POST a body that may carry `entities`. Telegram answers 400 when it cannot
   * accept them; retrying the same body without them keeps the message flowing.
   * `message is not modified` is never retried: the butler reads that text to
   * treat a repeated edit as success.
   */
  async function postWithEntities(
    method: string,
    body: Record<string, unknown>,
  ): Promise<TelegramResponse> {
    if (!("entities" in body)) return await call(method, body);

    try {
      return await call(method, body);
    } catch (error) {
      const retryable =
        error instanceof ChannelError &&
        error.status === 400 &&
        !error.message.toLowerCase().includes("message is not modified");
      if (!retryable) throw error;

      console.error(`telegram entities rejected on ${method}, retrying:`, error);
      const { entities: _dropped, ...plain } = body;
      return await call(method, plain);
    }
  }

  return {
    async parseInbound(req: Request): Promise<InboundEvent | null> {
      const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!opts.webhookSecret || secret !== opts.webhookSecret) return null;

      let update: TelegramUpdate;
      try {
        update = (await req.json()) as TelegramUpdate;
      } catch {
        return null;
      }

      if (update.message) {
        const message = update.message;
        // A message without a sender (e.g. a channel post) has no owner to map.
        if (!message.from) return null;

        const event: MessageEvent = {
          type: "message",
          channel: "telegram",
          chatId: String(message.chat.id),
          userId: String(message.from.id),
          text: message.text ?? null,
          eventId: `tg:${update.update_id}`,
        };
        return event;
      }

      if (update.callback_query) {
        const query = update.callback_query;
        if (!query.message || query.data === undefined) return null;

        const decoded = decodeAction(query.data);
        if (!decoded) return null;

        const event: ActionEvent = {
          type: "action",
          channel: "telegram",
          chatId: String(query.message.chat.id),
          userId: String(query.from.id),
          actionId: query.id,
          messageId: String(query.message.message_id),
          action: decoded.action,
          taskId: decoded.taskId,
          eventId: `tg:${update.update_id}`,
          ...(decoded.approvalId === undefined
            ? {}
            : { approvalId: decoded.approvalId }),
        };
        return event;
      }

      return null;
    },

    async send(
      chatId: string,
      msg: OutboundMessage,
    ): Promise<{ messageId: string }> {
      const chunks = renderForTelegram(msg.text);
      let messageId = "";

      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        const body: Record<string, unknown> = {
          chat_id: chatId,
          text: chunk.text,
        };
        if (chunk.entities.length > 0) body.entities = chunk.entities;
        if (index === chunks.length - 1 && msg.buttons && msg.buttons.length > 0) {
          body.reply_markup = toKeyboard(msg.buttons);
        }

        const response = await postWithEntities("sendMessage", body);
        messageId = String(response.result?.message_id ?? "");
      }

      return { messageId };
    },

    async edit(
      chatId: string,
      messageId: string,
      msg: OutboundMessage,
    ): Promise<void> {
      const chunks = renderForTelegram(msg.text);
      // One message, one `editMessageText`: a long original cannot be split
      // into several edits, so send it whole and unformatted instead of
      // dropping the tail (the approval decision lives at the end).
      if (chunks.length !== 1 && msg.text.length > 4096) {
        throw new ChannelError("Telegram edit requires a single message", 400);
      }
      const chunk =
        chunks.length === 1 ? chunks[0] : { text: msg.text, entities: [] };
      const body: Record<string, unknown> = {
        chat_id: chatId,
        message_id: messageId,
        text: chunk.text,
        reply_markup:
          msg.buttons && msg.buttons.length > 0
            ? toKeyboard(msg.buttons)
            : { inline_keyboard: [] },
      };
      if (chunk.entities.length > 0) body.entities = chunk.entities;

      await postWithEntities("editMessageText", body);
    },

    async answerAction(actionId: string, text?: string): Promise<void> {
      await call("answerCallbackQuery", {
        callback_query_id: actionId,
        ...(text === undefined ? {} : { text }),
      });
    },
  };
}
