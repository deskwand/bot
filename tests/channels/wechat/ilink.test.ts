import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ILinkError,
  createILinkClient,
  credentialsFromQrStatus,
  isSessionExpired,
  isTrustedBaseUrl,
  parseCredentials,
  splitWeChatText,
  type WeChatCredentials,
} from "../../../src/channels/wechat/ilink";
import ilinkQRFixture from "../../../contracts/fixtures/ilink-qr.json";

const CREDS: WeChatCredentials = {
  token: "bot-token",
  baseUrl: "https://ilinkai.weixin.qq.com/",
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
  return createILinkClient({ fetch: fetchImpl, baseUrl: "https://ilinkai.weixin.qq.com" });
}

describe("getUpdates", () => {
  it("sends auth headers and body", async () => {
    const { calls, fetchImpl } = fakeFetch([
      jsonResponse({ get_updates_buf: "next", msgs: [] }),
    ]);

    await client(fetchImpl).getUpdates(CREDS, "cursor-1");

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe("https://ilinkai.weixin.qq.com/ilink/bot/getupdates");
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
        image: null,
        file: null,
        voice: false,
      },
      {
        messageId: "u-2-msg",
        fromUserId: "u-2",
        contextToken: "",
        text: null,
        messageType: 1,
        image: null,
        file: null,
        voice: false,
      },
    ]);
  });

  it("reads the quoted message text from ref_msg", async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse({
        msgs: [
          {
            message_id: 43,
            from_user_id: "u-1",
            message_type: 1,
            item_list: [
              {
                type: 1,
                text_item: { text: "那明天再看" },
                ref_msg: {
                  title: "",
                  message_item: {
                    type: 1,
                    text_item: { text: "🤖 盯盘：价格回落了" },
                  },
                },
              },
            ],
          },
        ],
      }),
    ]);

    const result = await client(fetchImpl).getUpdates(CREDS, "");

    expect(result.updates[0].text).toBe("那明天再看");
    expect(result.updates[0].quotedText).toBe("🤖 盯盘：价格回落了");
  });

  it("falls back to the ref_msg title", async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse({
        msgs: [
          {
            message_id: 44,
            from_user_id: "u-1",
            message_type: 1,
            item_list: [
              {
                type: 1,
                text_item: { text: "那明天再看" },
                ref_msg: {
                  title: "🤖 盯盘：价格回落了",
                  message_item: { type: 2, image_item: {} },
                },
              },
            ],
          },
        ],
      }),
    ]);

    const result = await client(fetchImpl).getUpdates(CREDS, "");

    expect(result.updates[0].quotedText).toBe("🤖 盯盘：价格回落了");
  });

  it("falls back past a blank ref_msg text to the title", async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse({
        msgs: [
          {
            message_id: 46,
            from_user_id: "u-1",
            message_type: 1,
            item_list: [
              {
                type: 1,
                text_item: { text: "那明天再看" },
                ref_msg: {
                  title: "🤖 盯盘：见图",
                  message_item: { type: 1, text_item: { text: "   " } },
                },
              },
            ],
          },
        ],
      }),
    ]);

    const result = await client(fetchImpl).getUpdates(CREDS, "");

    expect(result.updates[0].quotedText).toBe("🤖 盯盘：见图");
  });

  it("leaves quotedText unset for an empty reference", async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse({
        msgs: [
          {
            message_id: 45,
            from_user_id: "u-1",
            message_type: 1,
            item_list: [
              {
                type: 1,
                text_item: { text: "那明天再看" },
                ref_msg: { title: "", message_item: { type: 2, image_item: {} } },
              },
            ],
          },
        ],
      }),
    ]);

    const result = await client(fetchImpl).getUpdates(CREDS, "");

    expect("quotedText" in result.updates[0]).toBe(false);
  });

  it("reads an image item's CDN reference", async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse({
        msgs: [
          {
            message_id: 9,
            from_user_id: "u-1",
            message_type: 1,
            item_list: [
              {
                type: 2,
                image_item: {
                  media: {
                    encrypt_query_param: "param-1",
                    aes_key: "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
                  },
                  aeskey: "00112233445566778899aabbccddeeff",
                  mid_size: 1024,
                },
              },
            ],
          },
        ],
      }),
    ]);

    const result = await client(fetchImpl).getUpdates(CREDS, "");

    expect(result.updates[0].image).toEqual({
      encryptQueryParam: "param-1",
      aesKeyHex: "00112233445566778899aabbccddeeff",
      mediaAesKey: "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
    });
    expect(result.updates[0].text).toBeNull();
  });

  it("parses a file item", async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse({
        msgs: [
          {
            message_id: 11,
            from_user_id: "u-1",
            message_type: 1,
            item_list: [
              {
                type: 4,
                file_item: {
                  media: { encrypt_query_param: "q", aes_key: "k" },
                  file_name: "合同.docx",
                  len: "1234",
                },
              },
            ],
          },
        ],
      }),
    ]);

    const result = await client(fetchImpl).getUpdates(CREDS, "");

    expect(result.updates[0].file).toEqual({
      encryptQueryParam: "q",
      mediaAesKey: "k",
      name: "合同.docx",
      size: 1234,
    });
  });

  it("ignores a file item without a download parameter", async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse({
        msgs: [
          {
            message_id: 12,
            from_user_id: "u-1",
            message_type: 1,
            item_list: [
              {
                type: 4,
                file_item: { media: {}, file_name: "合同.docx", len: "1234" },
              },
            ],
          },
        ],
      }),
    ]);

    const result = await client(fetchImpl).getUpdates(CREDS, "");

    expect(result.updates[0].file).toBeNull();
  });

  it("downloads and decrypts a file through the CDN", async () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const plain = new TextEncoder().encode("%PDF-1.4 x");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);

    const { calls, fetchImpl } = fakeFetch([
      new Response(ciphertext, { status: 200 }),
    ]);

    const bytes = await client(fetchImpl).downloadFile({
      encryptQueryParam: "q 1",
      mediaAesKey: btoa("00112233445566778899aabbccddeeff"),
      name: "合同.pdf",
    });

    expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.4 x");
    expect(calls[0].url).toBe(
      "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=q%201",
    );
  });

  it("downloads and decrypts an image through the CDN", async () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const plain = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);

    const { calls, fetchImpl } = fakeFetch([new Response(ciphertext, { status: 200 })]);

    const bytes = await client(fetchImpl).downloadImage({
      encryptQueryParam: "p 1",
      aesKeyHex: "00112233445566778899aabbccddeeff",
    });

    expect(Array.from(bytes ?? [])).toEqual(Array.from(plain));
    expect(calls[0].url).toBe(
      "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=p%201",
    );
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
      expect(call.url).toBe("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage");
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
      "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3",
    );
    expect(calls[0].method).toBe("GET");
  });

  it("sends the client version header and returns raw status", async () => {
    const { calls, fetchImpl } = fakeFetch([jsonResponse({ status: "scaned" })]);

    const result = await client(fetchImpl).getQrStatus("qr/+1");

    expect(result.status).toBe("scaned");
    expect(result.raw).toEqual({ status: "scaned" });
    expect(calls[0].url).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=qr%2F%2B1",
    );
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers["iLink-App-ClientVersion"]).toBe("1");
  });
});

describe("credentials", () => {
  const raw = {
    bot_token: "bot-token",
    baseurl: "https://ilinkai.weixin.qq.com/",
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

  it("uses the shared iLink fixture and rejects untrusted origins", () => {
    const fixture = ilinkQRFixture as Record<string, unknown>;
    expect(credentialsFromQrStatus(fixture)).toEqual({
      token: fixture.bot_token,
      baseUrl: fixture.baseurl,
      accountId: fixture.ilink_bot_id,
      userId: fixture.ilink_user_id,
    });
    expect(
      credentialsFromQrStatus({ ...fixture, baseurl: "https://example.com" }),
    ).toBeNull();
    expect(
      parseCredentials(
        JSON.stringify({
          token: fixture.bot_token,
          baseUrl: "http://ilinkai.weixin.qq.com",
          accountId: fixture.ilink_bot_id,
          userId: fixture.ilink_user_id,
        }),
      ),
    ).toMatchObject({ baseUrl: "http://ilinkai.weixin.qq.com" });
  });

  it("accepts only WeChat HTTPS service hosts", () => {
    expect(isTrustedBaseUrl("https://ilinkai.weixin.qq.com")).toBe(true);
    expect(isTrustedBaseUrl("https://a.b.weixin.qq.com/")).toBe(true);
    expect(isTrustedBaseUrl("http://ilinkai.weixin.qq.com")).toBe(false);
    expect(isTrustedBaseUrl("https://example.com")).toBe(false);
    expect(isTrustedBaseUrl("https://evilweixin.qq.com")).toBe(false);
    expect(isTrustedBaseUrl("https://weixin.qq.com.evil.example")).toBe(false);
  });
});

describe("trusted service origin", () => {
  it("does not send a token to an untrusted base URL", async () => {
    const { calls, fetchImpl } = fakeFetch([]);

    const error = await client(fetchImpl)
      .getUpdates({ ...CREDS, baseUrl: "https://example.com" }, "")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ILinkError);
    expect((error as ILinkError).message).toBe(
      "WECHAT_ILINK_UNTRUSTED_BASE_URL",
    );
    expect(calls).toEqual([]);
  });

  it("rejects redirects instead of forwarding the token", async () => {
    const { calls, fetchImpl } = fakeFetch([
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      }),
    ]);

    const error = await client(fetchImpl)
      .getUpdates(CREDS, "")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ILinkError);
    expect((error as ILinkError).message).toBe("WECHAT_ILINK_REDIRECT");
    expect(calls).toHaveLength(1);
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

describe("sendMedia", () => {
  const bytes = new TextEncoder().encode("hello world").buffer as ArrayBuffer;

  function cdnResponse(param: string | null) {
    return new Response(new Uint8Array(16), {
      status: 200,
      headers: param === null ? {} : { "x-encrypted-param": param },
    });
  }

  it("uploads an encrypted image and sends it as image_item", async () => {
    const { calls, fetchImpl } = fakeFetch([
      jsonResponse({ upload_param: "up-param" }),
      cdnResponse("dl-param"),
      jsonResponse({ message_id: 7 }),
    ]);

    await client(fetchImpl).sendMedia(CREDS, "owner-user", "ctx-1", {
      name: "shot.png",
      contentType: "image/png",
      bytes,
    });

    const upload = calls[0]!;
    expect(upload.url).toContain("/ilink/bot/getuploadurl");
    expect(upload.body).toMatchObject({
      media_type: 1,
      to_user_id: "owner-user",
      rawsize: 11,
      no_need_thumb: true,
    });
    expect(upload.body.filesize).toBe(16);
    expect(upload.body.aeskey).toMatch(/^[0-9a-f]{32}$/);

    const cdn = calls[1]!;
    expect(cdn.url).toContain("encrypted_query_param=up-param");
    expect(cdn.url).toContain("filekey=");

    const send = calls[2]!;
    expect(send.body.msg.context_token).toBe("ctx-1");
    expect(send.body.msg.message_type).toBe(2);
    expect(send.body.msg.message_state).toBe(2);
    const item = send.body.msg.item_list[0];
    expect(item.type).toBe(2);
    expect(item.image_item.mid_size).toBe(16);
    expect(item.image_item.media.encrypt_query_param).toBe("dl-param");
    expect(item.image_item.media.encrypt_type).toBe(1);
    // base64(hex) —— 32 个十六进制字符，不是 16 个原始字节
    expect(atob(item.image_item.media.aes_key)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sends other content types as file_item", async () => {
    const { calls, fetchImpl } = fakeFetch([
      jsonResponse({ upload_param: "up-param" }),
      cdnResponse("dl-param"),
      jsonResponse({ message_id: 8 }),
    ]);

    await client(fetchImpl).sendMedia(CREDS, "owner-user", "ctx-1", {
      name: "report.md",
      contentType: "text/markdown",
      bytes,
    });

    expect(calls[0]!.body.media_type).toBe(3);
    const item = calls[2]!.body.msg.item_list[0];
    expect(item.type).toBe(4);
    expect(item.file_item.file_name).toBe("report.md");
    expect(item.file_item.len).toBe("11");
  });

  it("fails when the CDN omits the encrypted param", async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse({ upload_param: "up-param" }),
      cdnResponse(null),
    ]);

    await expect(
      client(fetchImpl).sendMedia(CREDS, "owner-user", "ctx-1", {
        name: "a.txt",
        contentType: "text/plain",
        bytes,
      }),
    ).rejects.toBeInstanceOf(ILinkError);
  });

  it("does not retry a 4xx from getuploadurl", async () => {
    const { calls, fetchImpl } = fakeFetch([
      jsonResponse({ ret: -2, errmsg: "prepare failed" }, 400),
    ]);

    await expect(
      client(fetchImpl).sendMedia(CREDS, "owner-user", "ctx-1", {
        name: "a.txt",
        contentType: "text/plain",
        bytes,
      }),
    ).rejects.toBeInstanceOf(ILinkError);
    expect(calls).toHaveLength(1);
  });
});
