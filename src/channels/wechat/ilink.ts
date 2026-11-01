const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.0";
const DEFAULT_LIMIT = 2000;
const TEXT_ITEM_TYPE = 1;

export type WeChatCredentials = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
};

export class ILinkError extends Error {
  constructor(
    message: string,
    public code: number | undefined,
    public status: number,
  ) {
    super(message);
    this.name = "ILinkError";
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
  return isRecord(value) ? credentialsFromQrStatus(value) : null;
}

export function credentialsFromQrStatus(
  status: Record<string, unknown>,
): WeChatCredentials | null {
  const token = readString(status, "bot_token");
  const baseUrl = readString(status, "baseurl");
  const accountId = readString(status, "ilink_bot_id");
  const userId = readString(status, "ilink_user_id");
  if (!token || !baseUrl || !accountId || !userId) return null;
  return { token, baseUrl, accountId, userId };
}

export type WeChatUpdate = {
  messageId: string | null;
  fromUserId: string;
  contextToken: string;
  text: string | null;
  messageType: number;
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
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "GET",
      headers,
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
    const response = await fetchImpl(
      `${normalizeBaseUrl(creds.baseUrl || publicBaseUrl)}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${creds.token}`,
          "X-WECHAT-UIN": createUin(),
        },
        body: JSON.stringify(body),
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
  };
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
  const items = Array.isArray(value.item_list) ? value.item_list : [];
  const texts = items
    .filter(isRecord)
    .filter((item) => item.type === TEXT_ITEM_TYPE)
    .map((item) =>
      isRecord(item.text_item) ? (readString(item.text_item, "text") ?? "") : "",
    );
  return {
    messageId,
    fromUserId,
    contextToken,
    text: texts.length > 0 ? texts.join("\n") : null,
    messageType,
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

function createUin(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
