import { describe, expect, it } from "vitest";
import { ChannelError } from "../../src/channels/types";
import { createTelegramAdapter, splitMessage } from "../../src/channels/telegram";

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

describe("send", () => {
  it("posts a plain text message", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const result = await adapter.send("42", {
      text: "hello",
      buttons: [[{ label: "取消", data: "a:cancel:t1" }]],
    });

    expect(result.messageId).toBe("101");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({
      chat_id: "42",
      text: "hello",
      reply_markup: {
        inline_keyboard: [[{ text: "取消", callback_data: "a:cancel:t1" }]],
      },
    });
  });

  it("splits long text and attaches buttons to last chunk", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const adapter = makeAdapter(fetchImpl);

    const result = await adapter.send("42", {
      text: "x".repeat(5000),
      buttons: [[{ label: "取消", data: "a:cancel:t1" }]],
    });

    expect(calls.map((c) => c.body.text.length)).toEqual([4096, 904]);
    expect(calls[0].body.reply_markup).toBeUndefined();
    expect(calls[1].body.reply_markup.inline_keyboard[0][0].callback_data).toBe(
      "a:cancel:t1",
    );
    expect(result.messageId).toBe("102");
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

describe("splitMessage", () => {
  it("splits at the last newline within the limit", () => {
    const text = `${"a".repeat(5)}\n${"b".repeat(5)}`;
    expect(splitMessage(text, 8)).toEqual(["aaaaa\n", "bbbbb"]);
  });

  it("hard-splits when there is no newline", () => {
    expect(splitMessage("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("keeps short text whole and defaults to 4096", () => {
    expect(splitMessage("short")).toEqual(["short"]);
    expect(splitMessage("z".repeat(4097)).map((c) => c.length)).toEqual([
      4096, 1,
    ]);
  });
});
