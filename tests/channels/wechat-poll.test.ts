import { createCipheriv } from "node:crypto";
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setChannelOverride,
  setILinkFetchOverride,
  setPollTimingOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import type { ActionEvent, MessageEvent } from "../../src/protocol";
import { fakeChannel } from "../helpers/fake-channel";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const OWNER = "wx-owner";

const CREDS_A = {
  token: "token-a",
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "account-a",
  userId: OWNER,
};

const CREDS_B = {
  token: "token-b",
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "account-b",
  userId: "wx-owner-2",
};

type WeChatStateRow = {
  credentials_hash: string | null;
  cursor: string | null;
  status: string | null;
  last_poll_at: number | null;
  expiry_notified: number;
};

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
};

type Reply = { body: unknown; status?: number };

function jsonResponse(body: unknown, status = 200): Reply {
  return { body, status };
}

function scriptedILink(responses: Array<Reply | Error> = []) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });

    const next = responses.shift() ?? jsonResponse({});
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

let hubName = "channels";
let hubCounter = 0;

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName(hubName));
}

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

/** Builds an independent env fixture for one ChannelDO instance. */
function setEnv(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!savedEnv.has(key)) savedEnv.set(key, ENV[key]);
    ENV[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete ENV[key];
    else ENV[key] = value;
  }
  savedEnv.clear();
}

function readState(): Promise<WeChatStateRow | null> {
  return runInDurableObject(channels(), (_instance, state) => {
    return (
      state.storage.sql
        .exec<WeChatStateRow>(
          `SELECT credentials_hash, cursor, status, last_poll_at,
                  expiry_notified
           FROM wechat_state LIMIT 1`,
        )
        .toArray()[0] ?? null
    );
  });
}

function readContexts() {
  return runInDurableObject(channels(), (_instance, state) => {
    return state.storage.sql
      .exec<{ user_id: string; context_token: string }>(
        `SELECT user_id, context_token FROM wechat_contexts
         ORDER BY user_id`,
      )
      .toArray();
  });
}

function pollSchedules() {
  return runInDurableObject(channels(), async (instance) => {
    const target = instance as unknown as {
      listSchedules(): Promise<
        { id: string; callback: string; time: number }[]
      >;
    };
    return (await target.listSchedules()).filter(
      (schedule) => schedule.callback === "pollWeChat",
    );
  });
}

async function pollThroughDO(): Promise<number> {
  return runInDurableObject(channels(), async (instance) => {
    const target = instance as unknown as {
      pollWeChat(): Promise<void>;
      listSchedules(): Promise<{ id: string; callback: string }[]>;
      cancelSchedule(id: string): Promise<boolean>;
    };
    await target.pollWeChat();
    const schedules = (await target.listSchedules()).filter(
      (schedule) => schedule.callback === "pollWeChat",
    );
    for (const schedule of schedules) {
      await target.cancelSchedule(schedule.id);
    }
    return schedules.length;
  });
}

async function cancelSchedules(): Promise<void> {
  await runInDurableObject(channels(), async (instance) => {
    const target = instance as unknown as {
      listSchedules(): Promise<{ id: string }[]>;
      cancelSchedule(id: string): Promise<boolean>;
    };
    for (const schedule of await target.listSchedules()) {
      await target.cancelSchedule(schedule.id);
    }
  });
}

const restores: Array<() => Promise<void>> = [];

/** Replaces the Butler RPC entry so the test can see dispatched events. */
async function captureButler(): Promise<MessageEvent[]> {
  const events: MessageEvent[] = [];
  const stub = env.BUTLER.get(env.BUTLER.idFromName("owner"));

  await runInDurableObject(stub, (instance) => {
    const proto = Object.getPrototypeOf(instance) as {
      handleMessage(evt: MessageEvent): Promise<void>;
    };
    const original = proto.handleMessage;
    proto.handleMessage = async (evt) => {
      events.push(evt);
    };
    restores.push(async () => {
      await runInDurableObject(stub, (restored) => {
        const restoredProto = Object.getPrototypeOf(restored) as {
          handleMessage(evt: MessageEvent): Promise<void>;
        };
        restoredProto.handleMessage = original;
      });
    });
  });

  return events;
}

/** Records the ActionEvent a WeChat text command forwards to the Task DO. */
async function captureTaskAction(taskId: string): Promise<ActionEvent[]> {
  const events: ActionEvent[] = [];
  const stub = env.TASK.get(env.TASK.idFromName(taskId));
  await runInDurableObject(stub, (instance) => {
    const proto = Object.getPrototypeOf(instance) as {
      handleAction(evt: ActionEvent): Promise<string>;
    };
    const original = proto.handleAction;
    proto.handleAction = async (evt) => {
      events.push(evt);
      return "已批准";
    };
    restores.push(async () => {
      await runInDurableObject(stub, (restored) => {
        (
          Object.getPrototypeOf(restored) as {
            handleAction(evt: ActionEvent): Promise<string>;
          }
        ).handleAction = original;
      });
    });
  });
  return events;
}

let textActionCounter = 0;

function textActionUpdate(text: string, from = OWNER) {
  textActionCounter += 1;
  return {
    get_updates_buf: `cursor-${textActionCounter}`,
    msgs: [
      {
        message_id: `m-${textActionCounter}`,
        from_user_id: from,
        context_token: "ctx-1",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text } }],
      },
    ],
  };
}

beforeEach(async () => {
  hubName = `wechat-poll-${++hubCounter}`;
  setEnv({ ACTIVE_CHANNEL: "wechat" });
  // Install the test-only overrides before the DO is first constructed: its
  // onStart calls ensurePolling, which must not start a real polling chain.
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  setILinkFetchOverride(scriptedILink().fetchImpl);
  setPollTimingOverride({ runMs: 0, baseBackoffMs: 1, manualStart: true });
  setWeChatCredentialsOverride(null);
  await cancelSchedules();
  await runInDurableObject(channels(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM owner_addresses");
    state.storage.sql.exec("DELETE FROM wechat_state");
    state.storage.sql.exec("DELETE FROM wechat_contexts");
  });
});

afterEach(async () => {
  for (const restore of restores.splice(0)) await restore();
  await cancelSchedules();
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  setILinkFetchOverride(null);
  setPollTimingOverride(null);
  setWeChatCredentialsOverride(null);
  restoreEnv();
  vi.restoreAllMocks();
});

describe("ensurePolling", () => {
  it("does nothing without credentials", async () => {
    await channels().ensurePolling();

    expect(await pollSchedules()).toEqual([]);
    expect(await readState()).toBeNull();
  });

  it("starts one polling chain for new credentials and does not duplicate it", async () => {
    // This test exercises the initial schedule, so allow the automatic start.
    setPollTimingOverride({ runMs: 0, baseBackoffMs: 1 });
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));

    await channels().ensurePolling();

    const first = await pollSchedules();
    expect(first).toHaveLength(1);
    expect(await readState()).toMatchObject({
      status: "running",
      expiry_notified: 0,
    });

    await channels().ensurePolling();

    expect(await pollSchedules()).toHaveLength(1);
  });

  it("marks stored credentials with an untrusted origin as expired without polling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setWeChatCredentialsOverride(
      JSON.stringify({ ...CREDS_A, baseUrl: "https://example.com" }),
    );

    await channels().ensurePolling();

    expect(await pollSchedules()).toEqual([]);
    expect(await readState()).toMatchObject({
      status: "expired",
      expiry_notified: 1,
    });
    expect(warn).toHaveBeenCalledWith(
      "channel: WECHAT_CREDENTIALS_UNTRUSTED_BASE_URL",
    );
  });

  it("resets the cursor and contexts when the credentials change", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();

    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE wechat_state SET cursor = ?, expiry_notified = 1`,
        "old-cursor",
      );
      state.storage.sql.exec(
        `INSERT INTO wechat_contexts (user_id, context_token, updated_at)
         VALUES (?, ?, ?)`,
        OWNER,
        "old-context",
        Date.now(),
      );
    });
    const oldHash = (await readState())?.credentials_hash;

    setWeChatCredentialsOverride(JSON.stringify(CREDS_B));
    await channels().ensurePolling();

    const state = await readState();
    expect(state).toMatchObject({
      status: "running",
      cursor: null,
      expiry_notified: 0,
    });
    expect(state?.credentials_hash).not.toBe(oldHash);
    expect(await readContexts()).toEqual([]);

    // The reset itself scheduled nothing while manual start is enabled. Let the
    // real scheduler run to prove the new credentials start one poll chain.
    setPollTimingOverride({ runMs: 0, baseBackoffMs: 1 });
    await channels().ensurePolling();
    expect(await pollSchedules()).toHaveLength(1);
    await cancelSchedules();
  });

  it("does not restart polling after the session expired", async () => {
    const tg = fakeChannel();
    setChannelOverride("telegram", tg.adapter);
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();

    const { calls, fetchImpl } = scriptedILink([
      jsonResponse({ errcode: -14, errmsg: "expired" }),
    ]);
    setILinkFetchOverride(fetchImpl);

    expect(await pollThroughDO()).toBe(0);

    expect(await readState()).toMatchObject({
      status: "expired",
      expiry_notified: 1,
    });
    // An expired session must not notify the other channel.
    expect(tg.sent).toEqual([]);
    expect(await pollSchedules()).toEqual([]);

    await channels().ensurePolling();
    await channels().ensurePolling();
    await pollThroughDO();

    expect(await pollSchedules()).toEqual([]);
    expect(tg.sent).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("channel selection", () => {
  it("schedules no poll for stored WeChat credentials while Telegram is selected", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    setEnv({ ACTIVE_CHANNEL: "telegram" });
    const hub = env.CHANNELS.get(env.CHANNELS.idFromName("wechat-idle"));

    await hub.ensurePolling();

    expect(
      await runInDurableObject(hub, async (instance) => {
        const target = instance as unknown as {
          listSchedules(): Promise<{ callback: string }[]>;
        };
        return (await target.listSchedules()).filter(
          (schedule) => schedule.callback === "pollWeChat",
        );
      }),
    ).toEqual([]);
  });

  it("stops polling after a redeploy selects Telegram and keeps the conversation state", async () => {
    const hub = channels();

    // Persisted state of a WeChat deployment: a running chain scheduled by the
    // previous version, a cursor and a context. No live request is in flight.
    await runInDurableObject(hub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO wechat_state
           (credentials_hash, cursor, status, last_poll_at, expiry_notified)
         VALUES (?, ?, 'running', ?, 0)`,
        "hash-a",
        "kept-cursor",
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT INTO wechat_contexts (user_id, context_token, updated_at)
         VALUES (?, ?, ?)`,
        OWNER,
        "kept-context",
        Date.now(),
      );
      await instance.schedule(600, "pollWeChat");
    });
    expect(await pollSchedules()).toHaveLength(1);

    setEnv({ ACTIVE_CHANNEL: "telegram" });
    await evictDurableObject(hub);
    await hub.ensurePolling();

    expect(await pollSchedules()).toEqual([]);
    expect(await readState()).toMatchObject({
      status: "stopped",
      cursor: "kept-cursor",
    });
    expect(await readContexts()).toEqual([
      { user_id: OWNER, context_token: "kept-context" },
    ]);
  });

  it("resumes a stopped chain when the same credentials are selected again", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    const hub = channels();
    await hub.ensurePolling();
    await cancelSchedules();
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE wechat_state SET cursor = ?, status = 'stopped', last_poll_at = NULL`,
        "kept-cursor",
      );
    });

    // Enable the automatic start so resuming is observable as a scheduled poll.
    setPollTimingOverride({ runMs: 0, baseBackoffMs: 1 });
    await hub.ensurePolling();

    expect(await readState()).toMatchObject({
      status: "running",
      cursor: "kept-cursor",
    });
    expect(await pollSchedules()).toHaveLength(1);
    await cancelSchedules();
  });
});

describe("pollWeChat", () => {
  it("dispatches owner messages, ignores strangers, stores the cursor, and hands off", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();
    const { fetchImpl } = scriptedILink([
      jsonResponse({
        get_updates_buf: "cursor-2",
        msgs: [
          {
            message_id: "m1",
            from_user_id: OWNER,
            context_token: "ctx-1",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "hello" } }],
          },
          {
            message_id: "m2",
            from_user_id: "stranger",
            context_token: "ctx-stranger",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "nope" } }],
          },
          {
            from_user_id: OWNER,
            context_token: "ctx-img",
            message_type: 1,
            item_list: [{ type: 2, image_item: {} }],
          },
        ],
      }),
    ]);
    setILinkFetchOverride(fetchImpl);
    const events = await captureButler();

    const scheduled = await pollThroughDO();
    expect(scheduled).toBe(1);

    const route = await channels().currentRoute();
    await vi.waitFor(() => {
      expect(events).toEqual([
        {
          type: "message",
          channel: "wechat",
          chatId: OWNER,
          userId: OWNER,
          text: "hello",
          eventId: "wx:m1",
          routeKey: route.routeKey,
        },
        {
          type: "message",
          channel: "wechat",
          chatId: OWNER,
          userId: OWNER,
          text: null,
          eventId: "wx:cursor-2:2",
          routeKey: route.routeKey,
        },
      ]);
    });
    expect(await readState()).toMatchObject({
      cursor: "cursor-2",
      status: "running",
    });
    expect(await readContexts()).toEqual([
      { user_id: OWNER, context_token: "ctx-img" },
    ]);
  });

  it("reads the text WeChat already recognized for a voice message", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();
    const { fetchImpl } = scriptedILink([
      jsonResponse({
        get_updates_buf: "cursor-voice",
        msgs: [
          {
            message_id: "v1",
            from_user_id: OWNER,
            context_token: "ctx-voice",
            message_type: 1,
            item_list: [
              {
                type: 3,
                create_time_ms: 1,
                voice_item: {
                  text: "明天下午三点提醒我开会",
                  playtime: 8000,
                  encode_type: 4,
                  media: { encrypt_query_param: "q", aes_key: "k" },
                },
              },
            ],
          },
        ],
      }),
    ]);
    setILinkFetchOverride(fetchImpl);
    const events = await captureButler();

    await pollThroughDO();

    const route = await channels().currentRoute();
    await vi.waitFor(() => {
      expect(events).toEqual([
        {
          type: "message",
          channel: "wechat",
          chatId: OWNER,
          userId: OWNER,
          text: "明天下午三点提醒我开会",
          eventId: "wx:v1",
          routeKey: route.routeKey,
        },
      ]);
    });
  });

  it("marks a voice message as failed when WeChat recognized no text", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();
    const { fetchImpl } = scriptedILink([
      jsonResponse({
        get_updates_buf: "cursor-voice-empty",
        msgs: [
          {
            message_id: "v2",
            from_user_id: OWNER,
            context_token: "ctx-voice-empty",
            message_type: 1,
            item_list: [
              { type: 3, voice_item: { text: "", playtime: 8000, media: {} } },
            ],
          },
        ],
      }),
    ]);
    setILinkFetchOverride(fetchImpl);
    const events = await captureButler();

    await pollThroughDO();

    const route = await channels().currentRoute();
    await vi.waitFor(() => {
      expect(events).toEqual([
        {
          type: "message",
          channel: "wechat",
          chatId: OWNER,
          userId: OWNER,
          text: null,
          voiceFailed: true,
          eventId: "wx:v2",
          routeKey: route.routeKey,
        },
      ]);
    });
  });

  it("does not let an empty text item hide the voice transcript", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();
    const { fetchImpl } = scriptedILink([
      jsonResponse({
        get_updates_buf: "cursor-voice-empty-text",
        msgs: [
          {
            message_id: "v3",
            from_user_id: OWNER,
            context_token: "ctx-voice-empty-text",
            message_type: 1,
            item_list: [
              { type: 1, text_item: { text: "" } },
              { type: 3, voice_item: { text: "提醒我开会", playtime: 8000 } },
            ],
          },
        ],
      }),
    ]);
    setILinkFetchOverride(fetchImpl);
    const events = await captureButler();

    await pollThroughDO();

    const route = await channels().currentRoute();
    await vi.waitFor(() => {
      expect(events).toEqual([
        {
          type: "message",
          channel: "wechat",
          chatId: OWNER,
          userId: OWNER,
          text: "提醒我开会",
          eventId: "wx:v3",
          routeKey: route.routeKey,
        },
      ]);
    });
  });

  it("downloads an image message and hands it to the Butler", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();
    setPollTimingOverride({ runMs: 20, baseBackoffMs: 2 });

    const keyHex = "00112233445566778899aabbccddeeff";
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mM4YWODFTEMLQkAZZlQAS/gME0AAAAASUVORK5CYII=";
    const plain = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));
    const cipher = createCipheriv("aes-128-ecb", Buffer.from(keyHex, "hex"), null);
    const ciphertext = new Uint8Array(
      Buffer.concat([cipher.update(plain), cipher.final()]),
    );

    let first = true;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/ilink/bot/getupdates")) {
        if (!first) {
          return new Response(
            JSON.stringify({ get_updates_buf: "cursor-img", msgs: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        first = false;
        return new Response(
          JSON.stringify({
            get_updates_buf: "cursor-img",
            msgs: [
              {
                message_id: "img-1",
                from_user_id: OWNER,
                context_token: "ctx-1",
                message_type: 1,
                item_list: [
                  {
                    type: 2,
                    image_item: {
                      media: { encrypt_query_param: "p-1" },
                      aeskey: keyHex,
                    },
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(ciphertext, { status: 200 });
    }) as typeof fetch;
    setILinkFetchOverride(fetchImpl);

    const events = await captureButler();
    await pollThroughDO();

    const route = await channels().currentRoute();
    await vi.waitFor(() => {
      expect(events).toEqual([
        {
          type: "message",
          channel: "wechat",
          chatId: OWNER,
          userId: OWNER,
          text: null,
          images: [{ mimeType: "image/png", data: pngB64 }],
          eventId: "wx:img-1",
          routeKey: route.routeKey,
        },
      ]);
    });
  });

  it("falls back to a text-only event when the image cannot be fetched", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();
    setPollTimingOverride({ runMs: 20, baseBackoffMs: 2 });

    let first = true;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/ilink/bot/getupdates")) {
        if (!first) {
          return new Response(
            JSON.stringify({ get_updates_buf: "cursor-img-bad", msgs: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        first = false;
        return new Response(
          JSON.stringify({
            get_updates_buf: "cursor-img-bad",
            msgs: [
              {
                message_id: "img-2",
                from_user_id: OWNER,
                context_token: "ctx-1",
                message_type: 1,
                item_list: [
                  { type: 2, image_item: { media: { encrypt_query_param: "p-2" } } },
                ],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("denied", { status: 403 });
    }) as typeof fetch;
    setILinkFetchOverride(fetchImpl);

    const events = await captureButler();
    await pollThroughDO();

    const route = await channels().currentRoute();
    await vi.waitFor(() => {
      expect(events).toEqual([
        {
          type: "message",
          channel: "wechat",
          chatId: OWNER,
          userId: OWNER,
          text: null,
          imageFailed: true,
          eventId: "wx:img-2",
          routeKey: route.routeKey,
        },
      ]);
    });
  });

  it("backs off after a 5xx and keeps polling", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();
    setPollTimingOverride({ runMs: 20, baseBackoffMs: 2 });

    const { calls, fetchImpl } = scriptedILink([
      jsonResponse({ errmsg: "server down" }, 500),
      jsonResponse({ get_updates_buf: "cursor-after-retry", msgs: [] }),
    ]);
    setILinkFetchOverride(fetchImpl);

    const scheduled = await pollThroughDO();
    expect(scheduled).toBe(1);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(await readState()).toMatchObject({
      cursor: "cursor-after-retry",
      status: "running",
    });
  });
});

describe("WeChat sending", () => {
  it("sends with the stored context token", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO wechat_contexts (user_id, context_token, updated_at)
         VALUES (?, ?, ?)`,
        OWNER,
        "ctx-reply",
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES ('wechat', ?, ?)`,
        OWNER,
        Date.now(),
      );
    });

    const { calls, fetchImpl } = scriptedILink([
      jsonResponse({ message_id: "sent-1" }),
    ]);
    setILinkFetchOverride(fetchImpl);

    await channels().sendCurrent({ text: "reply" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/sendmessage",
    );
    expect(calls[0]?.headers.Authorization).toBe("Bearer token-a");
    expect(calls[0]?.body).toMatchObject({
      msg: {
        to_user_id: OWNER,
        context_token: "ctx-reply",
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: "reply" } }],
      },
    });
  });
});

describe("WeChat text actions", () => {
  it("executes an owner's approval command and replies on WeChat", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();

    const actions = await captureTaskAction("t3");
    const butlerEvents = await captureButler();
    const { calls, fetchImpl } = scriptedILink([
      jsonResponse(textActionUpdate("批准 t3 ap1")),
    ]);
    setILinkFetchOverride(fetchImpl);

    await pollThroughDO();

    await vi.waitFor(() => expect(actions).toHaveLength(1));
    expect(actions[0]).toMatchObject({
      type: "action",
      channel: "wechat",
      action: "approve",
      taskId: "t3",
      approvalId: "ap1",
    });
    // The command is executed, not handed to the model.
    expect(butlerEvents).toEqual([]);

    await vi.waitFor(() => {
      expect(calls.some((call) => call.url.endsWith("/sendmessage"))).toBe(
        true,
      );
    });
    const sent = calls.find((call) => call.url.endsWith("/sendmessage"));
    expect(sent?.body).toMatchObject({
      msg: {
        to_user_id: OWNER,
        item_list: [{ type: 1, text_item: { text: "已批准" } }],
      },
    });
  });

  it("executes a cancel command without an approval id", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();

    const actions = await captureTaskAction("t4");
    const { fetchImpl } = scriptedILink([
      jsonResponse(textActionUpdate("取消 t4")),
    ]);
    setILinkFetchOverride(fetchImpl);

    await pollThroughDO();

    await vi.waitFor(() => expect(actions).toHaveLength(1));
    expect(actions[0]).toMatchObject({ action: "cancel", taskId: "t4" });
    expect(actions[0]?.approvalId).toBeUndefined();
  });

  it("ignores a command from a stranger", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();

    const actions = await captureTaskAction("t5");
    const butlerEvents = await captureButler();
    const { fetchImpl } = scriptedILink([
      jsonResponse(textActionUpdate("批准 t5 ap1", "stranger")),
    ]);
    setILinkFetchOverride(fetchImpl);

    await pollThroughDO();

    expect(actions).toEqual([]);
    expect(butlerEvents).toEqual([]);
  });
});

describe("poll run length", () => {
  it("makes one long poll per invocation and hands off, so a redeploy is never stranded in an old run", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();
    // Production timing: no runMs override.
    setPollTimingOverride(null);

    const calls: string[] = [];
    setILinkFetchOverride((async () => {
      calls.push("getupdates");
      // A second long poll in the same invocation means the run kept going.
      // Withdraw the credentials so that run ends instead of spinning.
      if (calls.length > 1) setWeChatCredentialsOverride(null);
      return new Response(
        JSON.stringify({ get_updates_buf: `cursor-${calls.length}`, msgs: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);

    const scheduled = await pollThroughDO();

    expect(calls).toHaveLength(1);
    expect(scheduled).toBe(1);
    expect(await readState()).toMatchObject({ cursor: "cursor-1" });
  });
});

describe("poll ownership", () => {
  it("ignores overlapping callback invocations while a poll is awaiting updates", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();
    await runInDurableObject(channels(), async (instance) => {
      let release!: (response: Response) => void;
      let calls = 0;
      setILinkFetchOverride((async () => {
        calls++;
        if (calls > 1) return new Response(JSON.stringify({ errcode: -14 }));
        return new Promise<Response>((resolve) => { release = resolve; });
      }) as typeof fetch);
      const first = instance.pollWeChat();
      await vi.waitFor(() => expect(calls).toBe(1));
      await instance.pollWeChat();
      release(new Response(JSON.stringify({ get_updates_buf: "new-cursor" })));
      await first;
      for (const schedule of await instance.listSchedules()) await instance.cancelSchedule(schedule.id);
      expect(calls).toBe(1);
    });
    expect(await readState()).toMatchObject({ status: "running", cursor: "new-cursor" });
  });

  it.each(["success", "expired"])("discards an old credential response after rotation: %s", async (outcome) => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS_A));
    await channels().ensurePolling();
    await cancelSchedules();
    const tg = fakeChannel();
    setChannelOverride("telegram", tg.adapter);
    await runInDurableObject(channels(), async (instance) => {
      let release!: (response: Response) => void;
      setILinkFetchOverride((async () => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch);
      const first = instance.pollWeChat();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      setWeChatCredentialsOverride(JSON.stringify(CREDS_B));
      await instance.ensurePolling();
      release(new Response(JSON.stringify(outcome === "expired" ? { errcode: -14 } : {
        get_updates_buf: "stale-cursor", msgs: [{ message_id: "stale", message_type: 1, from_user_id: OWNER, context_token: "stale-context" }],
      })));
      await first;
      for (const schedule of await instance.listSchedules()) await instance.cancelSchedule(schedule.id);
    });
    expect(await readState()).toMatchObject({ status: "running", cursor: null, expiry_notified: 0 });
    expect(await readContexts()).toEqual([]);
    expect(tg.sent).toEqual([]);
  });
});
