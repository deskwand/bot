import { MAX_ARTIFACT_BYTES } from "../artifact";
import {
  decodeAction,
  type ActionEvent,
  type Button,
  type InboundEvent,
  type InboundImage,
  type MessageEvent,
  type OutboundMessage,
} from "../protocol";
import { extensionForMime } from "../tools/file-content";
import type { StoreInboundFile } from "./inbox";
import { prepareInboundImage, sniffImageType } from "./media";
import { transcribeVoice, type VoiceAi } from "./voice";
import { renderForTelegram } from "./telegram-render";
import { ChannelError, type ChannelAdapter, type OutboundArtifact } from "./types";

const API_BASE = "https://api.telegram.org";

type TelegramUser = { id: number };
type TelegramChat = { id: number };
type TelegramPhotoSize = { file_id: string; width: number; height: number };
type TelegramDocument = {
  file_id: string;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
};
type TelegramVoice = { file_id: string; duration: number; mime_type?: string };
type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
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
  result?: { message_id?: number; file_path?: string };
};

export type TelegramAdapterOptions = {
  token?: string;
  fetch?: typeof fetch;
  /** 缺省时语音降级为 `voiceFailed`，不影响其他消息。 */
  ai?: VoiceAi;
  /** 附件写入 inbox；缺省时不保存文件，行为与只收图片时一致。 */
  storeFile?: StoreInboundFile;
};

/** The `file_id` of the message's image: its largest photo, or an image document. */
function imageSource(message: TelegramMessage): string | null {
  const photo = message.photo?.[message.photo.length - 1];
  if (photo) return photo.file_id;
  const mimeType = message.document?.mime_type;
  if (message.document && mimeType?.startsWith("image/")) {
    return message.document.file_id;
  }
  return null;
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

  /** Bot API caps file downloads at 20 MB; anything larger is not usable. */
  const MAX_FILE_BYTES = 20 * 1024 * 1024;

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

  const CAPTION_LIMIT = 1024;

  /** Multipart upload for the media methods; the JSON helpers cannot carry bytes. */
  async function postMedia(
    method: string,
    field: string,
    chatId: string,
    file: OutboundArtifact,
    fallbackName: string,
  ): Promise<TelegramResponse> {
    if (!opts.token) throw new ChannelError("telegram not configured", 0);

    const form = new FormData();
    form.set("chat_id", chatId);
    const caption = file.name.slice(0, CAPTION_LIMIT);
    if (caption.length > 0) form.set("caption", caption);
    form.set(
      field,
      new File([file.bytes], file.name || fallbackName, {
        type: file.contentType,
      }),
    );

    const response = await fetchImpl(`${API_BASE}/bot${opts.token}/${method}`, {
      method: "POST",
      body: form,
    });
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

  /**
   * Fetches one file's bytes. Every failure returns `undefined` so a bad image
   * drops itself instead of the whole message.
   */
  async function downloadFile(fileId: string): Promise<Uint8Array | undefined> {
    let filePath: string | undefined;
    try {
      const response = await call("getFile", { file_id: fileId });
      filePath = response.result?.file_path;
    } catch (error) {
      console.error(`telegram getFile failed: ${(error as Error).message}`);
      return undefined;
    }
    if (!filePath) return undefined;

    try {
      const response = await fetchImpl(
        `${API_BASE}/file/bot${opts.token}/${filePath}`,
      );
      if (!response.ok) throw new Error(`status ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength > MAX_FILE_BYTES ? undefined : bytes;
    } catch (error) {
      console.error(`telegram file download failed: ${(error as Error).message}`);
      return undefined;
    }
  }

  return {
    async parseInbound(update: unknown): Promise<InboundEvent | null> {
      if (typeof update !== "object" || update === null) {
        // An invalid update is a parse failure, not an unsupported one. The
        // caller emits the fixed webhook_rejected event for it.
        throw new ChannelError("telegram payload invalid", 400);
      }
      const parsed = update as TelegramUpdate;

      if (parsed.message) {
        const message = parsed.message;
        // A message without a sender (e.g. a channel post) has no owner to map.
        if (!message.from) return null;

        const eventId = `tg:${parsed.update_id}`;
        const images: InboundImage[] = [];
        const source = imageSource(message);
        const document = message.document;
        const photo = message.photo?.[message.photo.length - 1];

        const files: MessageEvent["files"] = [];
        let fileFailed: MessageEvent["fileFailed"];
        const markFileFailed = (
          reason: NonNullable<MessageEvent["fileFailed"]>,
        ) => {
          fileFailed ??= reason;
        };
        const storeInInbox = async (
          name: string,
          bytes: Uint8Array,
          mimeType: string,
          bestEffort = false,
        ) => {
          if (!opts.storeFile) return;
          try {
            files.push(await opts.storeFile(eventId, name, bytes, mimeType));
          } catch (error) {
            console.error(
              `telegram inbox store failed (${eventId}): ${(error as Error).message}`,
            );
            if (!bestEffort) markFileFailed("download");
          }
        };

        // An explicitly oversized document is refused before any download.
        const documentTooLarge =
          opts.storeFile !== undefined &&
          document !== undefined &&
          document.file_size !== undefined &&
          document.file_size > MAX_ARTIFACT_BYTES;
        if (documentTooLarge) markFileFailed("too_large");
        const sourceIsOversizedDocument =
          documentTooLarge && document !== undefined && source === document.file_id;

        // One download serves both the image pipeline and the inbox copy.
        const imageBytes =
          source && !sourceIsOversizedDocument
            ? await downloadFile(source)
            : undefined;
        const prepared = imageBytes
          ? await prepareInboundImage(imageBytes)
          : undefined;
        if (prepared?.ok) images.push(prepared.image);
        else if (source) {
          console.warn(
            `telegram image dropped (${source}) reason=${prepared?.reason ?? "download"}`,
          );
        }

        if (opts.storeFile && document && !documentTooLarge) {
          const bytes =
            source === document.file_id
              ? imageBytes
              : await downloadFile(document.file_id);
          if (!bytes) {
            markFileFailed("download");
          } else if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
            markFileFailed("too_large");
          } else {
            await storeInInbox(
              document.file_name ?? document.file_id,
              bytes,
              document.mime_type ?? "application/octet-stream",
            );
          }
        }

        // A photo copy in the inbox is best effort: the image still reaches
        // the butler, so neither a failed download nor a failed store may turn
        // into a file failure report.
        if (opts.storeFile && photo && imageBytes) {
          if (imageBytes.byteLength > MAX_ARTIFACT_BYTES) {
            console.warn(
              `telegram photo not stored (${eventId}): larger than ${MAX_ARTIFACT_BYTES} bytes`,
            );
          } else {
            const mimeType = sniffImageType(imageBytes) ?? "image/jpeg";
            const extension = extensionForMime(mimeType) ?? "jpg";
            await storeInInbox(`photo.${extension}`, imageBytes, mimeType, true);
          }
        }

        // A voice note is transcribed here, not in the model: the transcript
        // becomes the message text, so the butler never sees audio.
        let transcript: string | undefined;
        if (message.voice) {
          const audio = await downloadFile(message.voice.file_id);
          if (!audio) {
            console.warn(`telegram voice download failed (${message.voice.file_id})`);
          }
          transcript = audio
            ? await transcribeVoice(audio, opts.ai)
            : undefined;
        }

        // A caption (voice notes may carry one) and the transcript both count
        // as text; neither may be dropped.
        const parts = [message.caption ?? message.text, transcript].filter(
          (part): part is string => typeof part === "string" && part !== "",
        );

        const event: MessageEvent = {
          type: "message",
          channel: "telegram",
          chatId: String(message.chat.id),
          userId: String(message.from.id),
          text: parts.length > 0 ? parts.join("\n") : null,
          ...(images.length > 0 ? { images } : {}),
          ...(files && files.length > 0 ? { files } : {}),
          ...(fileFailed ? { fileFailed } : {}),
          ...(source && images.length === 0 ? { imageFailed: true } : {}),
          ...(message.voice && transcript === undefined
            ? { voiceFailed: true }
            : {}),
          eventId,
        };
        return event;
      }

      if (parsed.callback_query) {
        const query = parsed.callback_query;
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
          eventId: `tg:${parsed.update_id}`,
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

    async sendArtifact(chatId: string, file: OutboundArtifact): Promise<void> {
      const mime = file.contentType.split(";")[0]!.trim().toLowerCase();
      const photo =
        mime === "image/jpeg" || mime === "image/png" || mime === "image/webp";

      // 图片和动图都可能被 Bot API 拒绝（尺寸、解码、超 10 MB），
      // 退回 document 保证主人一定能拿到文件。
      if (photo) {
        try {
          await postMedia("sendPhoto", "photo", chatId, file, "photo");
          return;
        } catch (error) {
          if (!(error instanceof ChannelError) || error.status !== 400) throw error;
        }
      } else if (mime === "image/gif") {
        try {
          await postMedia("sendAnimation", "animation", chatId, file, "animation");
          return;
        } catch (error) {
          if (!(error instanceof ChannelError) || error.status !== 400) throw error;
        }
      }

      await postMedia("sendDocument", "document", chatId, file, "artifact");
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
