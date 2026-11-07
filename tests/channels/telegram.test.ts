import { describe, expect, it, vi } from "vitest";
import { MAX_ARTIFACT_BYTES } from "../../src/artifact";
import type { StoreInboundFile } from "../../src/channels/inbox";
import { ChannelError } from "../../src/channels/types";
import { createTelegramAdapter } from "../../src/channels/telegram";
import type { MessageEvent } from "../../src/protocol";

type RecordedCall = {
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
};

const TOKEN = "123:test-token";

/** 真实的 8×8 纯色 PNG。 */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mM4YWODFTEMLQkAZZlQAS/gME0AAAAASUVORK5CYII=";

function pngBytes(): Uint8Array {
  const binary = atob(PNG_B64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function fakeFetch(
  responses: Array<{ status: number; body?: unknown; bytes?: Uint8Array } | Error> = [],
) {
  const calls: RecordedCall[] = [];
  let nextMessageId = 100;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });

    const queued = responses.shift();
    if (queued instanceof Error) throw queued;
    if (queued) {
      return queued.bytes
        ? new Response(queued.bytes, { status: queued.status })
        : new Response(JSON.stringify(queued.body), {
            status: queued.status,
            headers: { "content-type": "application/json" },
          });
    }

    nextMessageId += 1;
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: nextMessageId } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  return { calls, fetchImpl };
}

function makeAdapter(
  fetchImpl: typeof fetch,
  ai?: {
    run(model: string, inputs: { audio: string }): Promise<{ text?: string }>;
  },
  storeFile?: StoreInboundFile,
) {
  return createTelegramAdapter({
    token: TOKEN,
    fetch: fetchImpl,
    ai,
    storeFile,
  });
}

function fakeStore() {
  const stored: Array<{
    eventId: string;
    name: string;
    mimeType: string;
    size: number;
  }> = [];
  const storeFile: StoreInboundFile = async (eventId, name, bytes, mimeType) => {
    stored.push({ eventId, name, mimeType, size: bytes.byteLength });
    return {
      name,
      key: `inbox/${eventId}/${name}`,
      mimeType,
      size: bytes.byteLength,
    };
  };
  return { stored, storeFile };
}

describe("parseInbound", () => {
  it("rejects a payload that is not an object", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    await expect(adapter.parseInbound("nope")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("parses text message", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const event = await adapter.parseInbound({
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 7 },
        chat: { id: 42 },
        text: "hi",
      },
    });

    expect(event).toEqual({
      type: "message",
      channel: "telegram",
      chatId: "42",
      userId: "7",
      text: "hi",
      eventId: "tg:1",
    });
    expect(event).not.toHaveProperty("updateId");
  });

  it("parses non-text message with text null", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const event = await adapter.parseInbound({
      update_id: 2,
      message: {
        message_id: 11,
        from: { id: 7 },
        chat: { id: 42 },
        sticker: { file_id: "abc" },
      },
    });

    expect(event).toEqual({
      type: "message",
      channel: "telegram",
      chatId: "42",
      userId: "7",
      text: null,
      eventId: "tg:2",
    });
  });

  it("reply_to_message text becomes quotedText", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const event = await adapter.parseInbound({
      update_id: 3,
      message: {
        message_id: 12,
        from: { id: 7 },
        chat: { id: 42 },
        text: "那明天再看",
        reply_to_message: {
          message_id: 7,
          chat: { id: 42 },
          text: "🤖 盯盘：价格回落了",
        },
      },
    });

    expect(event).toMatchObject({
      text: "那明天再看",
      quotedText: "🤖 盯盘：价格回落了",
    });
  });

  it("reply_to_message caption becomes quotedText", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const event = await adapter.parseInbound({
      update_id: 4,
      message: {
        message_id: 13,
        from: { id: 7 },
        chat: { id: 42 },
        text: "那明天再看",
        reply_to_message: {
          message_id: 8,
          chat: { id: 42 },
          caption: "🤖 盯盘：见图",
          photo: [{ file_id: "quoted", width: 1280, height: 1280 }],
        },
      },
    });

    expect(event).toMatchObject({
      text: "那明天再看",
      quotedText: "🤖 盯盘：见图",
    });
    expect("images" in event!).toBe(false);
    // The quoted photo belongs to the earlier message; it is not re-downloaded.
    expect(calls).toHaveLength(0);
  });

  it("no reply leaves quotedText unset", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const event = await adapter.parseInbound({
      update_id: 5,
      message: {
        message_id: 14,
        from: { id: 7 },
        chat: { id: 42 },
        text: "hi",
      },
    });

    expect(event).not.toBeNull();
    expect("quotedText" in event!).toBe(false);
  });

  it("downloads the largest photo and keeps the caption as text", async () => {
    const { calls, fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "photos/file_7.png" } } },
      { status: 200, bytes: pngBytes() },
    ]);

    const event = await makeAdapter(fetchImpl).parseInbound({
      update_id: 7,
      message: {
        message_id: 70,
        from: { id: 1 },
        chat: { id: 42 },
        caption: "看图",
        photo: [
          { file_id: "small", width: 90, height: 90 },
          { file_id: "large", width: 1280, height: 1280 },
        ],
      },
    });

    expect(event).toMatchObject({
      text: "看图",
      images: [{ mimeType: "image/png", data: PNG_B64 }],
    });
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/getFile`);
    expect(calls[0].body).toEqual({ file_id: "large" });
    expect(calls[1].url).toBe(
      `https://api.telegram.org/file/bot${TOKEN}/photos/file_7.png`,
    );
  });

  it("accepts an image sent as a document", async () => {
    const { calls, fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "documents/f_1.png" } } },
      { status: 200, bytes: pngBytes() },
    ]);

    const event = await makeAdapter(fetchImpl).parseInbound({
      update_id: 8,
      message: {
        message_id: 80,
        from: { id: 1 },
        chat: { id: 42 },
        document: { file_id: "doc-1", mime_type: "image/png" },
      },
    });

    expect(event).toMatchObject({
      text: null,
      images: [{ mimeType: "image/png", data: PNG_B64 }],
    });
    expect(calls[0].body).toEqual({ file_id: "doc-1" });
  });

  it("stores a document and references it in files", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "documents/report.pdf" } } },
      { status: 200, bytes: new Uint8Array([1, 2, 3]) },
    ]);
    const { stored, storeFile } = fakeStore();

    const event = (await makeAdapter(fetchImpl, undefined, storeFile).parseInbound({
      update_id: 9,
      message: {
        message_id: 91,
        from: { id: 1 },
        chat: { id: 42 },
        caption: "总结一下",
        document: {
          file_id: "f1",
          mime_type: "application/pdf",
          file_name: "年报.pdf",
          file_size: 3,
        },
      },
    })) as MessageEvent;

    expect(event.text).toBe("总结一下");
    expect(event.files).toEqual([
      {
        name: "年报.pdf",
        key: "inbox/tg:9/年报.pdf",
        mimeType: "application/pdf",
        size: 3,
      },
    ]);
    expect(event.images).toBeUndefined();
    expect(stored).toEqual([
      {
        eventId: "tg:9",
        name: "年报.pdf",
        mimeType: "application/pdf",
        size: 3,
      },
    ]);
  });

  it("refuses an oversized document without downloading it", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const { storeFile } = fakeStore();

    const event = (await makeAdapter(fetchImpl, undefined, storeFile).parseInbound({
      update_id: 90,
      message: {
        message_id: 900,
        from: { id: 1 },
        chat: { id: 42 },
        document: {
          file_id: "f1",
          mime_type: "application/pdf",
          file_name: "big.pdf",
          file_size: MAX_ARTIFACT_BYTES + 1,
        },
      },
    })) as MessageEvent;

    expect(event.fileFailed).toBe("too_large");
    expect(event.files).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("marks a failed document download", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetchImpl } = fakeFetch([{ status: 200, body: { ok: false } }]);
    const { storeFile } = fakeStore();

    const event = (await makeAdapter(fetchImpl, undefined, storeFile).parseInbound({
      update_id: 91,
      message: {
        message_id: 901,
        from: { id: 1 },
        chat: { id: 42 },
        document: { file_id: "f1", mime_type: "application/pdf", file_size: 3 },
      },
    })) as MessageEvent;

    expect(event.fileFailed).toBe("download");
    expect(event.files).toBeUndefined();
  });

  it("also stores a photo as a file", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "photos/file_7.png" } } },
      { status: 200, bytes: pngBytes() },
    ]);
    const { storeFile } = fakeStore();

    const event = (await makeAdapter(fetchImpl, undefined, storeFile).parseInbound({
      update_id: 7,
      message: {
        message_id: 70,
        from: { id: 1 },
        chat: { id: 42 },
        caption: "看图",
        photo: [
          { file_id: "small", width: 90, height: 90 },
          { file_id: "large", width: 1280, height: 1280 },
        ],
      },
    })) as MessageEvent;

    expect(event.images).toHaveLength(1);
    expect(event.files?.[0]).toMatchObject({
      key: expect.stringMatching(/^inbox\/tg:\d+\/photo\.(jpg|png)$/),
    });
  });

  it("keeps the photo when the inbox store fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "photos/file_7.png" } } },
      { status: 200, bytes: pngBytes() },
    ]);
    const storeFile: StoreInboundFile = async () => {
      throw new Error("r2 down");
    };

    const event = (await makeAdapter(fetchImpl, undefined, storeFile).parseInbound({
      update_id: 71,
      message: {
        message_id: 710,
        from: { id: 1 },
        chat: { id: 42 },
        photo: [{ file_id: "large", width: 1280, height: 1280 }],
      },
    })) as MessageEvent;

    expect(event.images).toHaveLength(1);
    expect(event.fileFailed).toBeUndefined();
    expect(event.files).toBeUndefined();
  });

  it("uses the file id when the document has no name", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "documents/abc" } } },
      { status: 200, bytes: new Uint8Array([1, 2, 3]) },
    ]);
    const { storeFile } = fakeStore();

    const event = (await makeAdapter(fetchImpl, undefined, storeFile).parseInbound({
      update_id: 92,
      message: {
        message_id: 902,
        from: { id: 1 },
        chat: { id: 42 },
        document: { file_id: "abc", mime_type: "application/pdf" },
      },
    })) as MessageEvent;

    expect(event.files?.[0].name).toBe("abc");
  });

  it("marks a store failure as a failed download", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "documents/report.pdf" } } },
      { status: 200, bytes: new Uint8Array([1, 2, 3]) },
    ]);
    const storeFile: StoreInboundFile = async () => {
      throw new Error("r2 down");
    };

    const event = (await makeAdapter(fetchImpl, undefined, storeFile).parseInbound({
      update_id: 93,
      message: {
        message_id: 903,
        from: { id: 1 },
        chat: { id: 42 },
        document: { file_id: "f1", mime_type: "application/pdf" },
      },
    })) as MessageEvent;

    expect(event.fileFailed).toBe("download");
    expect(event.files).toBeUndefined();
  });

  it("keeps the text when the download fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "photos/x.png" } } },
      { status: 404, body: { ok: false } },
    ]);
    const { storeFile } = fakeStore();

    const event = await makeAdapter(fetchImpl, undefined, storeFile).parseInbound({
      update_id: 9,
      message: {
        message_id: 90,
        from: { id: 1 },
        chat: { id: 42 },
        caption: "看图",
        photo: [{ file_id: "large", width: 1280, height: 1280 }],
      },
    });

    expect(event).toEqual({
      type: "message",
      channel: "telegram",
      chatId: "42",
      userId: "1",
      text: "看图",
      imageFailed: true,
      eventId: "tg:9",
    });
    expect(event).not.toHaveProperty("fileFailed");
  });

  it("drops a download that is not an image", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "photos/x.png" } } },
      { status: 200, bytes: new TextEncoder().encode("<html>denied</html>") },
    ]);

    const event = await makeAdapter(fetchImpl).parseInbound({
      update_id: 10,
      message: {
        message_id: 100,
        from: { id: 1 },
        chat: { id: 42 },
        photo: [{ file_id: "large", width: 1280, height: 1280 }],
      },
    });

    expect(event).not.toHaveProperty("images");
    expect(event).toMatchObject({ imageFailed: true });
  });

  it("transcribes a voice message into the message text", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "voice/x.oga" } } },
      { status: 200, bytes: pngBytes() },
    ]);
    const ai = { run: async () => ({ text: "明天下午三点提醒我开会" }) };

    const event = await makeAdapter(fetchImpl, ai).parseInbound({
      update_id: 11,
      message: {
        message_id: 101,
        from: { id: 1 },
        chat: { id: 42 },
        voice: { file_id: "vf", duration: 8, mime_type: "audio/ogg" },
      },
    });

    expect(event).toMatchObject({
      text: "明天下午三点提醒我开会",
      eventId: "tg:11",
    });
    expect(event).not.toHaveProperty("voiceFailed");
  });

  it("marks a voice message as failed when the download fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "voice/x.oga" } } },
      new Error("network down"),
    ]);

    const event = await makeAdapter(fetchImpl).parseInbound({
      update_id: 12,
      message: {
        message_id: 102,
        from: { id: 1 },
        chat: { id: 42 },
        voice: { file_id: "vf", duration: 8, mime_type: "audio/ogg" },
      },
    });

    expect(event).toMatchObject({ text: null, voiceFailed: true });
  });

  it("keeps both the caption and the transcript", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "voice/x.oga" } } },
      { status: 200, bytes: pngBytes() },
    ]);
    const ai = { run: async () => ({ text: "把这段发给张三" }) };

    const event = await makeAdapter(fetchImpl, ai).parseInbound({
      update_id: 13,
      message: {
        message_id: 103,
        from: { id: 1 },
        chat: { id: 42 },
        caption: "转发一下",
        voice: { file_id: "vf", duration: 8, mime_type: "audio/ogg" },
      },
    });

    expect(event).toMatchObject({ text: "转发一下\n把这段发给张三" });
  });

  it("answers the caption when the voice could not be transcribed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { ok: true, result: { file_path: "voice/x.oga" } } },
      new Error("network down"),
    ]);

    const event = await makeAdapter(fetchImpl).parseInbound({
      update_id: 14,
      message: {
        message_id: 104,
        from: { id: 1 },
        chat: { id: 42 },
        caption: "看这个",
        voice: { file_id: "vf", duration: 8, mime_type: "audio/ogg" },
      },
    });

    expect(event).toMatchObject({ text: "看这个", voiceFailed: true });
  });

  it("parses callback query into ActionEvent", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const event = await adapter.parseInbound({
      update_id: 3,
      callback_query: {
        id: "cb-1",
        from: { id: 7 },
        data: "a:cancel:t1",
        message: { message_id: 11, chat: { id: 42 } },
      },
    });

    expect(event).toEqual({
      type: "action",
      channel: "telegram",
      chatId: "42",
      userId: "7",
      actionId: "cb-1",
      messageId: "11",
      action: "cancel",
      taskId: "t1",
      eventId: "tg:3",
    });
  });

  it("ignores callback with malformed data", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const event = await adapter.parseInbound({
      update_id: 4,
      callback_query: {
        id: "cb-2",
        from: { id: 7 },
        data: "not-an-action",
        message: { message_id: 11, chat: { id: 42 } },
      },
    });

    expect(event).toBeNull();
  });

  it("ignores unrelated updates", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    expect(
      await adapter.parseInbound({ update_id: 5, edited_message: {} }),
    ).toBeNull();
  });
});

describe("unconfigured token", () => {
  it("rejects only sending when the bot token is absent", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = createTelegramAdapter({ fetch: fetchImpl });

    const event = await adapter.parseInbound({
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 7 },
        chat: { id: 42 },
        text: "hi",
      },
    });
    expect(event).not.toBeNull();

    await expect(adapter.send("42", { text: "hi" })).rejects.toThrow(
      "telegram not configured",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("send", () => {
  it("renders markdown into entities instead of parse_mode", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    await adapter.send("42", { text: "已完成 **任务 A**" });

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      chat_id: "42",
      text: "已完成 任务 A",
      entities: [{ type: "bold", offset: 4, length: 4 }],
    });
    expect(calls[0].body).not.toHaveProperty("parse_mode");
  });

  it("omits entities when the text carries no formatting", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    await adapter.send("42", {
      text: "hello",
      buttons: [[{ label: "取消", data: "a:cancel:t1" }]],
    });

    expect(calls[0].body).toEqual({
      chat_id: "42",
      text: "hello",
      reply_markup: {
        inline_keyboard: [[{ text: "取消", callback_data: "a:cancel:t1" }]],
      },
    });
  });

  it("splits long text and attaches buttons to last chunk only", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const result = await adapter.send("42", {
      text: "x".repeat(5000),
      buttons: [[{ label: "取消", data: "a:cancel:t1" }]],
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.reduce((sum, c) => sum + c.body.text.length, 0)).toBe(5000);
    for (const call of calls) {
      expect(call.body.text.length).toBeLessThanOrEqual(4096);
    }
    expect(calls.slice(0, -1).every((c) => c.body.reply_markup === undefined)).toBe(
      true,
    );
    expect(
      calls[calls.length - 1].body.reply_markup.inline_keyboard[0][0].callback_data,
    ).toBe("a:cancel:t1");
    expect(result.messageId).toBe(String(100 + calls.length));
  });

  it("resends as plain text when telegram rejects the entities", async () => {
    const { calls, fetchImpl } = fakeFetch([
      {
        status: 400,
        body: { ok: false, description: "Bad Request: ENTITY_TEXT_INVALID" },
      },
    ]);
    const adapter = makeAdapter(fetchImpl);

    const result = await adapter.send("42", { text: "**粗体**" });

    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ chat_id: "42", text: "粗体" });
    expect(result.messageId).toBe("101");
  });

  it("does not retry a 400 that carried no entities", async () => {
    const { calls, fetchImpl } = fakeFetch([
      {
        status: 400,
        body: { ok: false, description: "Bad Request: chat not found" },
      },
    ]);
    const adapter = makeAdapter(fetchImpl);

    const error = await adapter.send("42", { text: "hello" }).catch((e) => e);

    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error.status).toBe(400);
  });

  it("throws ChannelError with status on ok:false", async () => {
    const { fetchImpl } = fakeFetch([
      {
        status: 429,
        body: { ok: false, description: "Too Many Requests: retry later" },
      },
    ]);
    const adapter = makeAdapter(fetchImpl);

    const error = await adapter.send("42", { text: "hello" }).catch((e) => e);

    expect(error).toBeInstanceOf(ChannelError);
    expect(error.status).toBe(429);
    expect(error.message).toContain("Too Many Requests");
  });
});

describe("edit", () => {
  it("edits text and replaces buttons", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    await adapter.edit("42", "9", {
      text: "updated",
      buttons: [[{ label: "批准", data: "a:approve:t1:ap1" }]],
    });

    expect(calls[0].url).toBe(
      `https://api.telegram.org/bot${TOKEN}/editMessageText`,
    );
    expect(calls[0].body).toEqual({
      chat_id: "42",
      message_id: "9",
      text: "updated",
      reply_markup: {
        inline_keyboard: [[{ text: "批准", callback_data: "a:approve:t1:ap1" }]],
      },
    });
  });

  it("sends an empty inline keyboard when there are no buttons", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    await adapter.edit("42", "9", { text: "done" });

    expect(calls[0].body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("renders markdown into entities", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    await adapter.edit("42", "9", { text: "`npm test` 通过" });

    expect(calls[0].body).toEqual({
      chat_id: "42",
      message_id: "9",
      text: "npm test 通过",
      entities: [{ type: "code", offset: 0, length: 8 }],
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("resends without entities when telegram rejects them", async () => {
    const { calls, fetchImpl } = fakeFetch([
      {
        status: 400,
        body: { ok: false, description: "Bad Request: ENTITY_TEXT_INVALID" },
      },
    ]);
    const adapter = makeAdapter(fetchImpl);

    await adapter.edit("42", "9", { text: "**粗体**" });

    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({
      chat_id: "42",
      message_id: "9",
      text: "粗体",
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("propagates message-is-not-modified without retrying", async () => {
    const { calls, fetchImpl } = fakeFetch([
      {
        status: 400,
        body: { ok: false, description: "Bad Request: message is not modified" },
      },
    ]);
    const adapter = makeAdapter(fetchImpl);

    const error = await adapter
      .edit("42", "9", { text: "**同样的文本**" })
      .catch((e) => e);

    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error.message).toContain("message is not modified");
  });

  it("edits the whole raw text when rendering split it and it still fits", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);
    const text = `${"**甲** ".repeat(100)}\n→ 已批准`;

    await adapter.edit("42", "9", { text });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.text).toBe(text);
    expect(calls[0].body).not.toHaveProperty("entities");
    expect(calls[0].body.message_id).toBe("9");
    expect(calls[0].body.text.endsWith("\n→ 已批准")).toBe(true);
  });

  it("rejects an over-long edit before making any request", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const error = await adapter
      .edit("42", "9", { text: "x".repeat(5000) })
      .catch((e) => e);

    expect(calls).toHaveLength(0);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error.message).toContain("single message");
  });

  it("never sets parse_mode", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    await adapter.send("42", { text: "*bold* _markdown_" });
    await adapter.edit("42", "9", { text: "`code`" });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.body).not.toHaveProperty("parse_mode");
    }
  });
});

describe("answerAction", () => {
  it("answers the callback query", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    await adapter.answerAction("cb-1", "Ciao");

    expect(calls[0].url).toBe(
      `https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`,
    );
    expect(calls[0].body).toEqual({ callback_query_id: "cb-1", text: "Ciao" });
  });

  it("omits text when not provided", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    await adapter.answerAction("cb-1");

    expect(calls[0].body).toEqual({ callback_query_id: "cb-1" });
  });
});

describe("sendArtifact", () => {
  it("sends an artifact as a document", async () => {
    const posts: { url: string; form: FormData }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(input), form: init?.body as FormData });
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 9 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const adapter = createTelegramAdapter({ token: TOKEN, fetch: fetchImpl });
    const bytes = new TextEncoder().encode("# body").buffer as ArrayBuffer;

    await adapter.sendArtifact("42", {
      name: "report.md",
      contentType: "text/markdown",
      bytes,
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url.endsWith("/sendDocument")).toBe(true);
    expect(posts[0]!.form.get("chat_id")).toBe("42");
    expect(posts[0]!.form.get("caption")).toBe("report.md");
    const document = posts[0]!.form.get("document") as File;
    expect(document.name).toBe("report.md");
    expect(await document.text()).toBe("# body");
  });
});

describe("sendArtifact media routing", () => {
  function recordingFetch(statuses: number[]) {
    const posts: { url: string; form: FormData }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(input), form: init?.body as FormData });
      const status = statuses.shift() ?? 200;
      return new Response(
        JSON.stringify(
          status === 200
            ? { ok: true, result: { message_id: 9 } }
            : { ok: false, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" },
        ),
        { status, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return { posts, fetchImpl };
  }

  it("sends a png as a photo", async () => {
    const { posts, fetchImpl } = recordingFetch([]);
    const adapter = createTelegramAdapter({ token: TOKEN, fetch: fetchImpl });

    await adapter.sendArtifact("42", {
      name: "shot.png",
      contentType: "image/png",
      bytes: pngBytes().buffer as ArrayBuffer,
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url.endsWith("/sendPhoto")).toBe(true);
    expect(posts[0]!.form.get("photo")).toBeInstanceOf(File);
  });

  it("falls back to a document when the photo upload is rejected", async () => {
    const { posts, fetchImpl } = recordingFetch([400, 200]);
    const adapter = createTelegramAdapter({ token: TOKEN, fetch: fetchImpl });

    await adapter.sendArtifact("42", {
      name: "shot.png",
      contentType: "image/png",
      bytes: pngBytes().buffer as ArrayBuffer,
    });

    expect(posts.map((post) => post.url.split("/").pop())).toEqual([
      "sendPhoto",
      "sendDocument",
    ]);
  });

  it("sends a gif as an animation", async () => {
    const { posts, fetchImpl } = recordingFetch([]);
    const adapter = createTelegramAdapter({ token: TOKEN, fetch: fetchImpl });

    await adapter.sendArtifact("42", {
      name: "loop.gif",
      contentType: "image/gif",
      bytes: new TextEncoder().encode("GIF89a").buffer as ArrayBuffer,
    });

    expect(posts[0]!.url.endsWith("/sendAnimation")).toBe(true);
  });

  it("sends unknown types as documents", async () => {
    const { posts, fetchImpl } = recordingFetch([]);
    const adapter = createTelegramAdapter({ token: TOKEN, fetch: fetchImpl });

    await adapter.sendArtifact("42", {
      name: "data.csv",
      contentType: "text/csv",
      bytes: new TextEncoder().encode("a,b").buffer as ArrayBuffer,
    });

    expect(posts[0]!.url.endsWith("/sendDocument")).toBe(true);
  });
});
