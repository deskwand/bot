import {
  decodeAction,
  type ActionEvent,
  type Button,
  type InboundEvent,
  type MessageEvent,
  type OutboundMessage,
} from "../protocol";
import { ChannelError, type ChannelAdapter } from "./types";

const API_BASE = "https://api.telegram.org";
const DEFAULT_LIMIT = 4096;

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
  token: string;
  webhookSecret: string;
  fetch?: typeof fetch;
};

/** Split text into Telegram-sized chunks, preferring newline boundaries. */
export function splitMessage(text: string, limit = DEFAULT_LIMIT): string[] {
  if (limit < 1) throw new Error("splitMessage limit must be positive");

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const newline = rest.lastIndexOf("\n", limit - 1);
    const cut = newline > 0 ? newline + 1 : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }

  chunks.push(rest);
  return chunks;
}

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

  return {
    async parseInbound(req: Request): Promise<InboundEvent | null> {
      const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== opts.webhookSecret) return null;

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
      const chunks = splitMessage(msg.text);
      let messageId = "";

      for (let index = 0; index < chunks.length; index++) {
        const isLast = index === chunks.length - 1;
        const body: Record<string, unknown> = {
          chat_id: chatId,
          text: chunks[index],
        };

        if (isLast && msg.buttons && msg.buttons.length > 0) {
          body.reply_markup = toKeyboard(msg.buttons);
        }

        const response = await call("sendMessage", body);
        messageId = String(response.result?.message_id ?? "");
      }

      return { messageId };
    },

    async edit(
      chatId: string,
      messageId: string,
      msg: OutboundMessage,
    ): Promise<void> {
      await call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: msg.text,
        reply_markup:
          msg.buttons && msg.buttons.length > 0
            ? toKeyboard(msg.buttons)
            : { inline_keyboard: [] },
      });
    },

    async answerAction(actionId: string, text?: string): Promise<void> {
      await call("answerCallbackQuery", {
        callback_query_id: actionId,
        ...(text === undefined ? {} : { text }),
      });
    },
  };
}
