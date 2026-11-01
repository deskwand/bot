import { describe, expect, it } from "vitest";
import { ChannelError } from "../../src/channels/types";
import { createTelegramAdapter } from "../../src/channels/telegram";

type RecordedCall = {
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
};

const TOKEN = "123:test-token";
const SECRET = "s3cret";

function fakeFetch(
  responses: Array<{ status: number; body: unknown } | Error> = [],
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
      return new Response(JSON.stringify(queued.body), {
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

function makeAdapter(fetchImpl: typeof fetch) {
  return createTelegramAdapter({
    token: TOKEN,
    webhookSecret: SECRET,
    fetch: fetchImpl,
  });
}

function updateRequest(payload: unknown, secret = SECRET): Request {
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify(payload),
  });
}

describe("parseInbound", () => {
  it("returns null for wrong secret", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const event = await adapter.parseInbound(
      updateRequest({ update_id: 1, message: { text: "hi" } }, "wrong"),
    );

    expect(event).toBeNull();
  });

  it("parses text message", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const event = await adapter.parseInbound(
      updateRequest({
        update_id: 1,
        message: {
          message_id: 10,
          from: { id: 7 },
          chat: { id: 42 },
          text: "hi",
        },
      }),
    );

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

    const event = await adapter.parseInbound(
      updateRequest({
        update_id: 2,
        message: {
          message_id: 11,
          from: { id: 7 },
          chat: { id: 42 },
          photo: [{ file_id: "abc" }],
        },
      }),
    );

    expect(event).toEqual({
      type: "message",
      channel: "telegram",
      chatId: "42",
      userId: "7",
      text: null,
      eventId: "tg:2",
    });
  });

  it("parses callback query into ActionEvent", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const event = await adapter.parseInbound(
      updateRequest({
        update_id: 3,
        callback_query: {
          id: "cb-1",
          from: { id: 7 },
          data: "a:cancel:t1",
          message: { message_id: 11, chat: { id: 42 } },
        },
      }),
    );

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

    const event = await adapter.parseInbound(
      updateRequest({
        update_id: 4,
        callback_query: {
          id: "cb-2",
          from: { id: 7 },
          data: "not-an-action",
          message: { message_id: 11, chat: { id: 42 } },
        },
      }),
    );

    expect(event).toBeNull();
  });

  it("ignores unrelated updates", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    expect(
      await adapter.parseInbound(updateRequest({ update_id: 5, edited_message: {} })),
    ).toBeNull();
  });
});

describe("unconfigured secrets", () => {
  it("rejects every webhook when the webhook secret is absent", async () => {
    const { fetchImpl } = fakeFetch();
    const adapter = createTelegramAdapter({ token: TOKEN, fetch: fetchImpl });

    expect(
      await adapter.parseInbound(
        updateRequest({
          update_id: 1,
          message: {
            message_id: 10,
            from: { id: 7 },
            chat: { id: 42 },
            text: "hi",
          },
        }),
      ),
    ).toBeNull();
  });

  it("rejects only sending when the bot token is absent", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = createTelegramAdapter({
      webhookSecret: SECRET,
      fetch: fetchImpl,
    });

    const event = await adapter.parseInbound(
      updateRequest({
        update_id: 1,
        message: {
          message_id: 10,
          from: { id: 7 },
          chat: { id: 42 },
          text: "hi",
        },
      }),
    );
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
