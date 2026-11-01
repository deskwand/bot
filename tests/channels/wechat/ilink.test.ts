import { describe, expect, it } from "vitest";
import {
  ILinkError,
  createILinkClient,
  credentialsFromQrStatus,
  isSessionExpired,
  parseCredentials,
  splitWeChatText,
  type WeChatCredentials,
} from "../../../src/channels/wechat/ilink";

const CREDS: WeChatCredentials = {
  token: "bot-token",
  baseUrl: "https://ilink.example/",
  accountId: "bot-account",
  userId: "owner-user",
};

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  signal: AbortSignal | null | undefined;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(responses: Array<Response | Error> = []) {
  const calls: RecordedCall[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal,
    });

    const queued = responses.shift();
    if (queued instanceof Error) throw queued;
    return queued ?? jsonResponse({});
  }) as typeof fetch;

  return { calls, fetchImpl };
}

function client(fetchImpl: typeof fetch) {
  return createILinkClient({ fetch: fetchImpl, baseUrl: "https://ilink.example" });
}

describe("getUpdates", () => {
  it("sends auth headers and body", async () => {
    const { calls, fetchImpl } = fakeFetch([
      jsonResponse({ get_updates_buf: "next", msgs: [] }),
    ]);

    await client(fetchImpl).getUpdates(CREDS, "cursor-1");

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe("https://ilink.example/ilink/bot/getupdates");
    expect(call.method).toBe("POST");
    expect(call.headers.AuthorizationType).toBe("ilink_bot_token");
    expect(call.headers.Authorization).toBe("Bearer bot-token");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["X-WECHAT-UIN"]).toMatch(/^[A-Za-z0-9+/]{6}==$/);
    expect(call.body).toEqual({
      get_updates_buf: "cursor-1",
      base_info: { channel_version: "1.0.0" },
    });
  });

  it("parses text and image-only messages plus the new cursor", async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse({
        get_updates_buf: "cursor-2",
        msgs: [
          {
            message_id: 42,
            from_user_id: "u-1",
            context_token: "ctx-1",
            message_type: 1,
            item_list: [
              { type: 1, text_item: { text: "hello" } },
              { type: 1, text_item: { text: "world" } },
              { type: 2, image_item: {} },
            ],
          },
          {
            message_id: "u-2-msg",
            from_user_id: "u-2",
            message_type: 1,
            item_list: [{ type: 2, image_item: {} }],
          },
        ],
      }),
    ]);

    const result = await client(fetchImpl).getUpdates(CREDS, "cursor-1");

    expect(result.cursor).toBe("cursor-2");
    expect(result.updates).toEqual([
      {
        messageId: "42",
        fromUserId: "u-1",
        contextToken: "ctx-1",
        text: "hello\nworld",
        messageType: 1,
      },
      {
        messageId: "u-2-msg",
        fromUserId: "u-2",
        contextToken: "",
        text: null,
        messageType: 1,
      },
    ]);
  });

  it("keeps the old cursor when the response has none", async () => {
    const { fetchImpl } = fakeFetch([jsonResponse({ msgs: [] })]);

    const result = await client(fetchImpl).getUpdates(CREDS, "keep-me");

    expect(result.cursor).toBe("keep-me");
    expect(result.updates).toEqual([]);
  });

  it("passes the abort signal through", async () => {
    const controller = new AbortController();
    const { calls, fetchImpl } = fakeFetch([jsonResponse({ msgs: [] })]);

    await client(fetchImpl).getUpdates(CREDS, "", controller.signal);

    expect(calls[0].signal).toBe(controller.signal);
  });
});

describe("sendText", () => {
  it("splits 5000 characters into three messages with context token", async () => {
    const { calls, fetchImpl } = fakeFetch([
      jsonResponse({ message_id: 1 }),
      jsonResponse({ message_id: 2 }),
      jsonResponse({ message_id: 3 }),
    ]);

    await client(fetchImpl).sendText(
      CREDS,
      "u-1",
      "ctx-token",
      "a".repeat(5000),
    );

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.url).toBe("https://ilink.example/ilink/bot/sendmessage");
      expect(call.method).toBe("POST");
      expect(call.headers.Authorization).toBe("Bearer bot-token");
      expect(call.body.msg).toMatchObject({
        from_user_id: "",
        to_user_id: "u-1",
        message_type: 2,
        message_state: 2,
        context_token: "ctx-token",
      });
      expect(call.body.msg.client_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(call.body.base_info).toEqual({ channel_version: "1.0.0" });
    }
    expect(calls.map((c) => c.body.msg.item_list[0].text_item.text.length)).toEqual([
      2000, 2000, 1000,
    ]);
    expect(
      calls.every(
        (c) =>
          c.body.msg.item_list[0].type === 1 &&
          typeof c.body.msg.item_list[0].text_item.text === "string",
      ),
    ).toBe(true);
  });
});

describe("errors", () => {
  it("flags errcode -14 as an expired session", async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse({ errcode: -14, errmsg: "expired" }),
    ]);

    const error = await client(fetchImpl)
      .getUpdates(CREDS, "")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ILinkError);
    expect(isSessionExpired(error)).toBe(true);
    expect((error as ILinkError).code).toBe(-14);
    expect((error as ILinkError).status).toBe(200);
    expect((error as ILinkError).message).toBe("expired");
  });

  it("uses errmsg and status for HTTP failures", async () => {
    const { fetchImpl } = fakeFetch([jsonResponse({ errmsg: "boom" }, 500)]);

    const error = await client(fetchImpl)
      .sendText(CREDS, "u-1", "ctx", "hi")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ILinkError);
    expect((error as ILinkError).status).toBe(500);
    expect((error as ILinkError).code).toBeUndefined();
    expect((error as ILinkError).message).toBe("boom");
    expect(isSessionExpired(error)).toBe(false);
  });

  it("falls back to an HTTP code for non-JSON HTTP failures", async () => {
    const { fetchImpl } = fakeFetch([new Response("nope", { status: 500 })]);

    const error = await client(fetchImpl)
      .getUpdates(CREDS, "")
      .catch((e: unknown) => e);

    expect((error as ILinkError).message).toBe("WECHAT_ILINK_HTTP_500");
    expect((error as ILinkError).status).toBe(500);
  });

  it("rejects non-JSON successful responses", async () => {
    const { fetchImpl } = fakeFetch([new Response("not json", { status: 200 })]);

    const error = await client(fetchImpl)
      .getUpdates(CREDS, "")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ILinkError);
    expect((error as ILinkError).message).toBe("WECHAT_ILINK_RESPONSE_INVALID");
    expect((error as ILinkError).status).toBe(200);
  });

  it("treats a non-zero ret as an API error", async () => {
    const { fetchImpl } = fakeFetch([jsonResponse({ ret: 7 })]);

    const error = await client(fetchImpl)
      .sendText(CREDS, "u-1", "ctx", "hi")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ILinkError);
    expect((error as ILinkError).code).toBe(7);
    expect((error as ILinkError).message).toBe("WECHAT_ILINK_API_ERROR");
  });
});

describe("QR login", () => {
  it("returns the QR code and image content", async () => {
    const { calls, fetchImpl } = fakeFetch([
      jsonResponse({ qrcode: "qr-1", qrcode_img_content: "data:image/png;base64,AA==" }),
    ]);

    const result = await client(fetchImpl).getBotQrCode();

    expect(result).toEqual({
      qrcode: "qr-1",
      imageContent: "data:image/png;base64,AA==",
    });
    expect(calls[0].url).toBe(
      "https://ilink.example/ilink/bot/get_bot_qrcode?bot_type=3",
    );
    expect(calls[0].method).toBe("GET");
  });

  it("sends the client version header and returns raw status", async () => {
    const { calls, fetchImpl } = fakeFetch([jsonResponse({ status: "scaned" })]);

    const result = await client(fetchImpl).getQrStatus("qr/+1");

    expect(result.status).toBe("scaned");
    expect(result.raw).toEqual({ status: "scaned" });
    expect(calls[0].url).toBe(
      "https://ilink.example/ilink/bot/get_qrcode_status?qrcode=qr%2F%2B1",
    );
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers["iLink-App-ClientVersion"]).toBe("1");
  });
});

describe("credentials", () => {
  const raw = {
    bot_token: "bot-token",
    baseurl: "https://ilink.example/",
    ilink_bot_id: "bot-account",
    ilink_user_id: "owner-user",
  };

  it("parses credentials from JSON", () => {
    expect(parseCredentials(JSON.stringify(raw))).toEqual(CREDS);
  });

  it("rejects invalid JSON and missing fields", () => {
    expect(parseCredentials("not json")).toBeNull();
    expect(parseCredentials("{}")).toBeNull();
    expect(parseCredentials(JSON.stringify({ ...raw, ilink_user_id: undefined }))).toBeNull();
  });

  it("builds credentials from a confirmed QR status", () => {
    expect(credentialsFromQrStatus(raw)).toEqual(CREDS);
    expect(credentialsFromQrStatus({ ...raw, bot_token: undefined })).toBeNull();
  });
});

describe("splitWeChatText", () => {
  it("splits at newlines before hitting the limit", () => {
    expect(splitWeChatText("aaaa\nbbbb", 5)).toEqual(["aaaa\n", "bbbb"]);
  });

  it("defaults to 2000 characters", () => {
    const chunks = splitWeChatText("x".repeat(4001));
    expect(chunks.map((chunk) => chunk.length)).toEqual([2000, 2000, 1]);
  });
});
