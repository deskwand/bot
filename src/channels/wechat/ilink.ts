import { createCipheriv, createHash } from "node:crypto";
import {
  WECHAT_CDN_BASE_URL,
  downloadWeChatMedia,
  type WeChatImageRef,
} from "./media.ts";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.0";
const DEFAULT_LIMIT = 2000;
const TEXT_ITEM_TYPE = 1;
const IMAGE_ITEM_TYPE = 2;
const FILE_ITEM_TYPE = 4;

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

/**
 * How a transport failure may be retried.
 *
 * - `protocol` / `security`: the peer answered something we must not act on.
 *   Retrying with the same secret only repeats the violation, so the caller
 *   has to stop and persist a terminal failure.
 * - `transient`: no usable answer yet (timeout, 5xx, network). Safe to retry
 *   later with the same state.
 * - `abort`: the request was cancelled. Retryable, but any secret it carried
 *   (a PIN) must not be replayed.
 */
export type TransportFailure = "protocol" | "security" | "transient" | "abort";

/** Fixed wire codes that mean the peer is not trustworthy. */
const SECURITY_FAILURES: readonly string[] = [
  "WECHAT_ILINK_UNTRUSTED_BASE_URL",
  "WECHAT_ILINK_UNTRUSTED_REDIRECT",
  "WECHAT_REALNAME_UNTRUSTED_BASE_URL",
];

/** Cancellation surfaces as a DOMException or as the reason's name. */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Classifies anything a transport call can throw, including the raw `fetch`
 * rejections the real client lets through. Unknown errors are transient: a
 * bug is not evidence that the invite is unusable.
 */
export function transportFailureOf(error: unknown): TransportFailure {
  if (error instanceof ILinkError) {
    if (SECURITY_FAILURES.includes(error.message)) return "security";
    if (error.status === 408 || error.status === 429) return "transient";
    return error.status >= 500 ? "transient" : "protocol";
  }
  return isAbortError(error) ? "abort" : "transient";
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

export type WeChatFileRef = {
  encryptQueryParam: string;
  mediaAesKey?: string;
  name: string;
  size?: number;
};

/**
 * 一条消息里的一个图片或文件，按 `item_list` 的顺序排列。
 *
 * 微信允许一条消息带多个媒体 item：多选发送和合并转发都会这样到达，
 * 所以这里保留全部，而不是只取第一个。
 */
export type WeChatMediaItem =
  | { kind: "image"; image: WeChatImageRef }
  | { kind: "file"; file: WeChatFileRef };

export type WeChatUpdate = {
  messageId: string | null;
  fromUserId: string;
  contextToken: string;
  text: string | null;
  messageType: number;
  /** 该条消息的图片与文件，按 item 顺序；可能是多个。 */
  media: WeChatMediaItem[];
  /** 该条消息的 item 里有 `voice_item`，即这是一条语音。 */
  voice: boolean;
  /** 被引用消息的文本；引用里没有文本时缺省。 */
  quotedText?: string;
};

export type QrStatus =
  | "wait"
  | "scaned"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "verify_code_expired"
  | "binded_redirect"
  | "confirmed"
  | "expired";

const QR_STATUSES: readonly QrStatus[] = [
  "wait",
  "scaned",
  "scaned_but_redirect",
  "need_verifycode",
  "verify_code_blocked",
  "verify_code_expired",
  "binded_redirect",
  "confirmed",
  "expired",
];

/**
 * `signal` stays the first argument: existing callers pass an AbortSignal
 * positionally and must keep compiling.
 */
export type QrCodeOptions = {
  /** Bot tokens already present on this instance; the server caps the list. */
  localTokens?: readonly string[];
  /** Real-name ticket that lets the server accept another binding. */
  spamTicket?: string;
};

export type QrStatusOptions = {
  /** PIN entered on the invite page, sent only on the next status poll. */
  verifyCode?: string;
  /** Trusted base returned by `scaned_but_redirect`. */
  baseUrl?: string;
};

const LOCAL_TOKEN_LIMIT = 10;

const REALNAME_BASE_URL = "https://weixin110.qq.com";
const REALNAME_PATH = "/security/acct/botrealnameverifycgi";
const REALNAME_PLUGIN_VERSION = "3.0.1/deskwand";

export type RealnameResultStatus = "wait" | "ok" | "denied" | "refresh";

export const REALNAME_WAIT_MS = 480_000;
export const REALNAME_TICKET_MIN_MS = 60_000;

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

  async function postJson(
    baseUrl: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!isTrustedBaseUrl(baseUrl)) {
      throw new ILinkError("WECHAT_ILINK_UNTRUSTED_BASE_URL", undefined, 0);
    }
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "manual",
      signal,
    });
    return parseResponse(response);
  }

  async function getRealname(
    query: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!isTrustedRealnameUrl(REALNAME_BASE_URL)) {
      throw new ILinkError("WECHAT_REALNAME_UNTRUSTED_BASE_URL", undefined, 0);
    }
    const response = await fetchImpl(
      `${REALNAME_BASE_URL}${REALNAME_PATH}?${query}`,
      { method: "GET", headers: {}, redirect: "manual", signal },
    );
    return parseResponse(response);
  }

  async function post(
    creds: WeChatCredentials,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const targetBaseUrl = normalizeBaseUrl(creds.baseUrl || publicBaseUrl);
    return postJson(targetBaseUrl, path, body, {
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${creds.token}`,
      "X-WECHAT-UIN": createUin(),
    }, signal);
  }

  return {
    async getBotQrCode(
      signal?: AbortSignal,
      options?: QrCodeOptions,
    ): Promise<{ qrcode: string; imageContent: string }> {
      const body: Record<string, unknown> = {
        local_token_list: (options?.localTokens ?? []).slice(-LOCAL_TOKEN_LIMIT),
      };
      if (options?.spamTicket) body.bot_spam_ticket = options.spamTicket;
      const raw = await postJson(
        publicBaseUrl,
        "/ilink/bot/get_bot_qrcode?bot_type=3",
        body,
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
      options?: QrStatusOptions,
    ): Promise<{
      status: QrStatus;
      raw: Record<string, unknown>;
      redirectBaseUrl?: string;
    }> {
      const baseUrl = options?.baseUrl
        ? normalizeBaseUrl(options.baseUrl)
        : publicBaseUrl;
      const pin = options?.verifyCode
        ? `&verify_code=${encodeURIComponent(options.verifyCode)}`
        : "";
      const raw = await get(
        baseUrl,
        `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${pin}`,
        { "iLink-App-ClientVersion": "1" },
        signal,
      );
      const status = raw.status;
      if (typeof status !== "string" || !QR_STATUSES.includes(status as QrStatus)) {
        throw new ILinkError("WECHAT_ILINK_RESPONSE_INVALID", undefined, 200);
      }
      const redirectBaseUrl =
        status === "scaned_but_redirect"
          ? readRedirectBaseUrl(raw)
          : undefined;
      return {
        status: status as QrStatus,
        raw,
        ...(redirectBaseUrl === undefined ? {} : { redirectBaseUrl }),
      };
    },

    async getRealnameAuthUrl(
      signal?: AbortSignal,
    ): Promise<{ authUrl: string; ticket: string; expiresAt?: number }> {
      const raw = await getRealname(
        `step=get_auth_url&plugin_version=${REALNAME_PLUGIN_VERSION}`,
        signal,
      );
      const payload = realnamePayload(raw);
      const authUrl = readString(payload, "auth_url");
      const ticket = readString(payload, "bot_spam_ticket");
      if (!authUrl || !ticket || !isTrustedRealnameAuthUrl(authUrl)) {
        throw new ILinkError("WECHAT_REALNAME_RESPONSE_INVALID", undefined, 200);
      }
      const expiresAt = readEpochMs(payload, "expire_time");
      return { authUrl, ticket, ...(expiresAt === undefined ? {} : { expiresAt }) };
    },

    async queryRealnameResult(
      ticket: string,
      signal?: AbortSignal,
    ): Promise<{
      status: RealnameResultStatus;
      ticket?: string;
      expiresAt?: number;
    }> {
      if (!ticket) {
        throw new ILinkError("WECHAT_REALNAME_RESPONSE_INVALID", undefined, 200);
      }
      const raw = await getRealname(
        `step=query_auth_result&bot_spam_ticket=${encodeURIComponent(ticket)}`,
        signal,
      );
      const payload = realnamePayload(raw);
      const status = readRealnameStatus(payload);
      if (!status) {
        throw new ILinkError("WECHAT_REALNAME_RESPONSE_INVALID", undefined, 200);
      }
      const nextTicket = readString(payload, "bot_spam_ticket");
      const expiresAt = readEpochMs(payload, "expire_time");
      return {
        status,
        ...(nextTicket === undefined ? {} : { ticket: nextTicket }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
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
      return await downloadWeChatMedia(fetchImpl, WECHAT_CDN_BASE_URL, image, signal);
    },

    async downloadFile(
      file: WeChatFileRef,
      signal?: AbortSignal,
    ): Promise<Uint8Array | undefined> {
      return await downloadWeChatMedia(fetchImpl, WECHAT_CDN_BASE_URL, file, signal);
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
  // The upstream `errmsg` is never copied into an error: a QR/real-name
  // failure can echo the submitted PIN, the spam ticket, the QR token or a
  // bot token, and error text is logged by callers. Code and status are the
  // only safe, actionable parts.
  if (!response.ok) {
    throw new ILinkError(
      `WECHAT_ILINK_HTTP_${response.status}`,
      readNumericCode(raw),
      response.status,
    );
  }
  if (!raw) {
    throw new ILinkError("WECHAT_ILINK_RESPONSE_INVALID", undefined, response.status);
  }
  const code = readNumericCode(raw);
  if (code !== undefined && code !== 0) {
    throw new ILinkError("WECHAT_ILINK_API_ERROR", code, response.status);
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
  const media: WeChatMediaItem[] = items.flatMap((item): WeChatMediaItem[] => {
    const image = item.type === IMAGE_ITEM_TYPE ? toImageRef(item) : null;
    if (image) return [{ kind: "image", image }];
    const file = item.type === FILE_ITEM_TYPE ? toFileRef(item) : null;
    return file ? [{ kind: "file", file }] : [];
  });

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

  const quotedText = quotedTextOf(items);

  return {
    messageId,
    fromUserId,
    contextToken,
    text: texts.length > 0 ? texts.join("\n") : (voiceText ?? null),
    messageType,
    media,
    voice,
    ...(quotedText ? { quotedText } : {}),
  };
}

/** The text of the message this one replies to, if the items carry one. */
function quotedTextOf(items: Record<string, unknown>[]): string | undefined {
  const ref = items
    .map((item) => (isRecord(item.ref_msg) ? item.ref_msg : null))
    .find((candidate) => candidate !== null);
  if (!ref) return undefined;

  const messageItem = isRecord(ref.message_item) ? ref.message_item : null;
  const textItem =
    messageItem && isRecord(messageItem.text_item)
      ? messageItem.text_item
      : null;
  const text = [readString(textItem, "text"), readString(ref, "title")]
    .map((candidate) => candidate?.trim())
    .find((candidate) => candidate);
  return text;
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

/** A downloadable file, or `null` when the item has no CDN parameter. */
function toFileRef(item: Record<string, unknown>): WeChatFileRef | null {
  const file = item.file_item;
  if (!isRecord(file)) return null;

  const media = isRecord(file.media) ? file.media : {};
  const encryptQueryParam = readString(media, "encrypt_query_param");
  if (!encryptQueryParam) return null;

  const mediaAesKey = readString(media, "aes_key");
  const size = readSize(file, "len");
  return {
    encryptQueryParam,
    ...(mediaAesKey === undefined ? {} : { mediaAesKey }),
    name: readString(file, "file_name") ?? "file",
    ...(size === undefined ? {} : { size }),
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

/** iLink sends sizes as decimal strings; accept a number too. */
function readSize(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = value[key];
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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

/** The scan redirect must stay on an origin allowed to receive credentials. */
function readRedirectBaseUrl(
  raw: Record<string, unknown>,
): string {
  const value =
    readString(raw, "baseurl") ??
    readString(raw, "redirect_baseurl") ??
    readString(raw, "redirect_host");
  if (!value) {
    throw new ILinkError("WECHAT_ILINK_UNTRUSTED_REDIRECT", undefined, 0);
  }
  const candidate = /^https?:\/\//i.test(value)
    ? value
    : `https://${value}`;
  if (!isTrustedBaseUrl(candidate)) {
    throw new ILinkError("WECHAT_ILINK_UNTRUSTED_REDIRECT", undefined, 0);
  }
  return normalizeBaseUrl(candidate);
}

/** The real-name CGI is a single fixed origin, not a configurable base URL. */
export function isTrustedRealnameUrl(value: string): boolean {
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
  return parsed.hostname.toLowerCase().replace(/\.$/, "") === "weixin110.qq.com";
}

/**
 * The auth URL is opened in the operator's browser, so it must be a plain
 * HTTPS WeChat URL. It is never used to carry the bot token.
 */
export function isTrustedRealnameAuthUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== "443") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return host === "qq.com" || host.endsWith(".qq.com");
}

/**
 * The real-name CGI answers inside `data` (`{"ret":0,"data":{…}}`). Reads
 * fall back to the bare object so a flat answer stays readable.
 */
function realnamePayload(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  return isRecord(raw.data) ? raw.data : raw;
}

/**
 * The result field is `auth_status` in the live CGI; older shapes used
 * `status`. Only the four known values are mapped.
 */
function readRealnameStatus(
  raw: Record<string, unknown>,
): RealnameResultStatus | null {
  const value = raw.auth_status ?? raw.status;
  if (value === 0 || value === "0") return "wait";
  if (value === 1 || value === "1") return "ok";
  if (value === 2 || value === "2") return "denied";
  if (value === 3 || value === "3") return "refresh";
  return null;
}

/** Epoch seconds from the CGI, normalised to milliseconds. */
function readEpochMs(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = value[key];
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}
