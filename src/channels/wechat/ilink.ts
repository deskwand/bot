import { createCipheriv, createHash } from "node:crypto";
import {
  WECHAT_CDN_BASE_URL,
  downloadWeChatImage,
  type WeChatImageRef,
} from "./media.ts";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.0";
const DEFAULT_LIMIT = 2000;
const TEXT_ITEM_TYPE = 1;
const IMAGE_ITEM_TYPE = 2;

export type WeChatCredentials = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
};

export class ILinkError extends Error {
  public code: number | undefined;
  public status: number;

  constructor(
    message: string,
    code: number | undefined,
    status: number,
  ) {
    super(message);
    this.name = "ILinkError";
    this.code = code;
    this.status = status;
  }
}

export function isSessionExpired(e: unknown): boolean {
  return e instanceof ILinkError && e.code === -14;
}

export function parseCredentials(json: string): WeChatCredentials | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  return credentialsFromQrStatus(value) ?? credentialsFromStored(value);
}

/** Accepts the assembled credential object written by `wechat-login`. */
function credentialsFromStored(
  value: Record<string, unknown>,
): WeChatCredentials | null {
  const token = readString(value, "token");
  const baseUrl = readString(value, "baseUrl");
  const accountId = readString(value, "accountId");
  const userId = readString(value, "userId");
  if (!token || !baseUrl || !accountId || !userId) return null;
  // Origin is enforced by the caller when it is about to use the token. Keep
  // an existing stored credential parseable so a bad origin can be shown as a
  // distinct, recoverable state instead of "invalid credentials".
  return { token, baseUrl, accountId, userId };
}

export function credentialsFromQrStatus(
  status: Record<string, unknown>,
): WeChatCredentials | null {
  const token = readString(status, "bot_token");
  const baseUrl = readString(status, "baseurl");
  const accountId = readString(status, "ilink_bot_id");
  const userId = readString(status, "ilink_user_id");
  if (!token || !baseUrl || !accountId || !userId) return null;
  if (!isTrustedBaseUrl(baseUrl)) return null;
  return { token, baseUrl, accountId, userId };
}

export type WeChatUpdate = {
  messageId: string | null;
  fromUserId: string;
  contextToken: string;
  text: string | null;
  messageType: number;
  image: WeChatImageRef | null;
  /** 该条消息的 item 里有 `voice_item`，即这是一条语音。 */
  voice: boolean;
};

type QrStatus = "wait" | "scaned" | "confirmed" | "expired";

const QR_STATUSES: readonly QrStatus[] = [
  "wait",
  "scaned",
  "confirmed",
  "expired",
];

export function createILinkClient(opts: {
  fetch?: typeof fetch;
  baseUrl?: string;
}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const publicBaseUrl = normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL);

  async function get(
    baseUrl: string,
    path: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!isTrustedBaseUrl(baseUrl)) {
      throw new ILinkError("WECHAT_ILINK_UNTRUSTED_BASE_URL", undefined, 0);
    }
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "GET",
      headers,
      redirect: "manual",
      signal,
    });
    return parseResponse(response);
  }

  async function post(
    creds: WeChatCredentials,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const targetBaseUrl = normalizeBaseUrl(creds.baseUrl || publicBaseUrl);
    if (!isTrustedBaseUrl(targetBaseUrl)) {
      throw new ILinkError("WECHAT_ILINK_UNTRUSTED_BASE_URL", undefined, 0);
    }
    const response = await fetchImpl(
      `${targetBaseUrl}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${creds.token}`,
          "X-WECHAT-UIN": createUin(),
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal,
      },
    );
    return parseResponse(response);
  }

  return {
    async getBotQrCode(
      signal?: AbortSignal,
    ): Promise<{ qrcode: string; imageContent: string }> {
      const raw = await get(
        publicBaseUrl,
        "/ilink/bot/get_bot_qrcode?bot_type=3",
        {},
        signal,
      );
      const qrcode = readString(raw, "qrcode");
      const imageContent = readString(raw, "qrcode_img_content");
      if (!qrcode || !imageContent) {
        throw new ILinkError("WECHAT_ILINK_RESPONSE_INVALID", undefined, 200);
      }
      return { qrcode, imageContent };
    },

    async getQrStatus(
      qrcode: string,
      signal?: AbortSignal,
    ): Promise<{ status: QrStatus; raw: Record<string, unknown> }> {
      const raw = await get(
        publicBaseUrl,
        `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        { "iLink-App-ClientVersion": "1" },
        signal,
      );
      const status = raw.status;
      if (typeof status !== "string" || !QR_STATUSES.includes(status as QrStatus)) {
        throw new ILinkError("WECHAT_ILINK_RESPONSE_INVALID", undefined, 200);
      }
      return { status: status as QrStatus, raw };
    },

    async getUpdates(
      creds: WeChatCredentials,
      cursor: string,
      signal?: AbortSignal,
    ): Promise<{ cursor: string; updates: WeChatUpdate[] }> {
      const raw = await post(
        creds,
        "/ilink/bot/getupdates",
        {
          get_updates_buf: cursor,
          base_info: { channel_version: CHANNEL_VERSION },
        },
        signal,
      );
      const nextCursor = readString(raw, "get_updates_buf") ?? cursor;
      const msgs = Array.isArray(raw.msgs) ? raw.msgs : [];
      return {
        cursor: nextCursor,
        updates: msgs.filter(isRecord).map(toWeChatUpdate),
      };
    },

    async sendText(
      creds: WeChatCredentials,
      toUserId: string,
      contextToken: string,
      text: string,
      signal?: AbortSignal,
    ): Promise<void> {
      for (const chunk of splitWeChatText(text)) {
        await post(
          creds,
          "/ilink/bot/sendmessage",
          {
            msg: {
              from_user_id: "",
              to_user_id: toUserId,
              client_id: crypto.randomUUID(),
              message_type: 2,
              message_state: 2,
              context_token: contextToken,
              item_list: [{ type: TEXT_ITEM_TYPE, text_item: { text: chunk } }],
            },
            base_info: { channel_version: CHANNEL_VERSION },
          },
          signal,
        );
      }
    },

    async sendMedia(
      creds: WeChatCredentials,
      toUserId: string,
      contextToken: string,
      file: { name: string; contentType: string; bytes: ArrayBuffer },
      signal?: AbortSignal,
    ): Promise<void> {
      const plain = new Uint8Array(file.bytes);
      const aesKey = crypto.getRandomValues(new Uint8Array(16));
      const aesKeyHex = hexOf(aesKey);
      const cipher = createCipheriv("aes-128-ecb", aesKey, null);
      const ciphertext = new Uint8Array(
        Buffer.concat([cipher.update(plain), cipher.final()]),
      );
      const image = /^image\/(png|jpeg|webp)$/.test(file.contentType);
      const filekey = hexOf(crypto.getRandomValues(new Uint8Array(16)));

      const upload = await post(
        creds,
        "/ilink/bot/getuploadurl",
        {
          filekey,
          media_type: image ? 1 : 3,
          to_user_id: toUserId,
          rawsize: plain.byteLength,
          rawfilemd5: createHash("md5").update(plain).digest("hex"),
          filesize: ciphertext.byteLength,
          aeskey: aesKeyHex,
          no_need_thumb: true,
          base_info: { channel_version: CHANNEL_VERSION },
        },
        signal,
      );

      const uploadParam = readString(upload, "upload_param");
      if (!uploadParam) {
        throw new ILinkError("WECHAT_ILINK_RESPONSE_INVALID", undefined, 200);
      }
      const cdn = await fetchImpl(
        `${WECHAT_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: ciphertext,
          signal,
        },
      );
      const downloadParam = cdn.headers.get("x-encrypted-param");
      if (!cdn.ok || !downloadParam) {
        throw new ILinkError("WECHAT_ILINK_UPLOAD_FAILED", undefined, cdn.status);
      }

      // 文件与图片都要 base64(hex key)，写成 base64(raw) 微信会显示灰块。
      const media = {
        encrypt_query_param: downloadParam,
        aes_key: btoa(aesKeyHex),
        encrypt_type: 1,
      };
      await post(
        creds,
        "/ilink/bot/sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: toUserId,
            client_id: crypto.randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [
              image
                ? {
                    type: 2,
                    image_item: { media, mid_size: ciphertext.byteLength },
                  }
                : {
                    type: 4,
                    file_item: {
                      media,
                      file_name: file.name,
                      len: String(plain.byteLength),
                    },
                  },
            ],
          },
          base_info: { channel_version: CHANNEL_VERSION },
        },
        signal,
      );
    },

    async downloadImage(
      image: WeChatImageRef,
      signal?: AbortSignal,
    ): Promise<Uint8Array | undefined> {
      return await downloadWeChatImage(fetchImpl, WECHAT_CDN_BASE_URL, image, signal);
    },
  };
}

/** Lowercase hex, the encoding iLink expects for `aeskey` and `filekey`. */
function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Split text into WeChat-sized chunks, preferring newline boundaries. */
export function splitWeChatText(text: string, limit = DEFAULT_LIMIT): string[] {
  if (limit < 1) throw new Error("splitWeChatText limit must be positive");

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

async function parseResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  if (response.status >= 300 && response.status < 400) {
    throw new ILinkError("WECHAT_ILINK_REDIRECT", undefined, response.status);
  }
  const raw = parseRecord(await response.text());
  if (!response.ok) {
    throw new ILinkError(
      readString(raw, "errmsg") ?? `WECHAT_ILINK_HTTP_${response.status}`,
      readNumericCode(raw),
      response.status,
    );
  }
  if (!raw) {
    throw new ILinkError("WECHAT_ILINK_RESPONSE_INVALID", undefined, response.status);
  }
  const code = readNumericCode(raw);
  if (code !== undefined && code !== 0) {
    throw new ILinkError(
      readString(raw, "errmsg") ?? "WECHAT_ILINK_API_ERROR",
      code,
      response.status,
    );
  }
  return raw;
}

function parseRecord(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function toWeChatUpdate(value: Record<string, unknown>): WeChatUpdate {
  const rawId = value.message_id;
  const messageId =
    typeof rawId === "string" || typeof rawId === "number"
      ? String(rawId)
      : null;
  const fromUserId = readString(value, "from_user_id") ?? "";
  const contextToken = readString(value, "context_token") ?? "";
  const messageType =
    typeof value.message_type === "number" ? value.message_type : 0;
  const items = (Array.isArray(value.item_list) ? value.item_list : []).filter(
    isRecord,
  );
  // An empty text item is not text: it must not shadow a voice transcript.
  const texts = items
    .filter((item) => item.type === TEXT_ITEM_TYPE)
    .map((item) =>
      isRecord(item.text_item) ? (readString(item.text_item, "text") ?? "") : "",
    )
    .filter((text) => text !== "");
  const image =
    items
      .filter((item) => item.type === IMAGE_ITEM_TYPE)
      .map(toImageRef)
      .find((ref) => ref !== null) ?? null;

  // WeChat recognizes voice on its side and ships the transcript in the item.
  // Nothing is downloaded or decoded: no SILK, no audio model, no CPU cost.
  const voice = items.some((item) => item.voice_item !== undefined);
  const voiceText = voice
    ? items
        .map((item) =>
          isRecord(item.voice_item)
            ? readString(item.voice_item, "text")?.trim()
            : undefined,
        )
        .find((text) => text !== undefined && text !== "")
    : undefined;

  return {
    messageId,
    fromUserId,
    contextToken,
    text: texts.length > 0 ? texts.join("\n") : (voiceText ?? null),
    messageType,
    image,
    voice,
  };
}

/** A downloadable image, or `null` when the item has no CDN parameter. */
function toImageRef(item: Record<string, unknown>): WeChatImageRef | null {
  const image = item.image_item;
  if (!isRecord(image)) return null;

  const media = isRecord(image.media) ? image.media : {};
  const encryptQueryParam = readString(media, "encrypt_query_param");
  if (!encryptQueryParam) return null;

  const aesKeyHex = readString(image, "aeskey");
  const mediaAesKey = readString(media, "aes_key");
  return {
    encryptQueryParam,
    ...(aesKeyHex === undefined ? {} : { aesKeyHex }),
    ...(mediaAesKey === undefined ? {} : { mediaAesKey }),
  };
}

function readNumericCode(
  value: Record<string, unknown> | null,
): number | undefined {
  if (!value) return undefined;
  if (typeof value.errcode === "number") return value.errcode;
  return typeof value.ret === "number" ? value.ret : undefined;
}

function readString(
  value: Record<string, unknown> | null,
  key: string,
): string | undefined {
  if (!value) return undefined;
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The only service origins allowed to receive the bot token. The desktop
 * client applies the same allowlist before publishing credentials.
 */
export function isTrustedBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== "443") return false;
  if (parsed.search || parsed.hash) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return host === "weixin.qq.com" || host.endsWith(".weixin.qq.com");
}

function createUin(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
