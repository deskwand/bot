import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setChannelOverride,
  setILinkFetchOverride,
  setPollTimingOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import type { MessageEvent } from "../../src/protocol";
import { fakeChannel } from "../helpers/fake-channel";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const OWNER = "wx-owner";

const CREDS_A = {
  token: "token-a",
  baseUrl: "https://ilink.example",
  accountId: "account-a",
  userId: OWNER,
};

const CREDS_B = {
  token: "token-b",
  baseUrl: "https://ilink.example",
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

beforeEach(async () => {
  hubName = `wechat-poll-${++hubCounter}`;
  setEnv({ ACTIVE_CHANNEL: "wechat" });
  await cancelSchedules();
  await runInDurableObject(channels(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM owner_addresses");
    state.storage.sql.exec("DELETE FROM wechat_state");
    state.storage.sql.exec("DELETE FROM wechat_contexts");
  });
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  setILinkFetchOverride(scriptedILink().fetchImpl);
  setPollTimingOverride({ runMs: 0, baseBackoffMs: 1 });
  setWeChatCredentialsOverride(null);
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
    expect(await pollSchedules()).toHaveLength(1);
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
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE wechat_state SET cursor = ?, status = 'stopped', last_poll_at = NULL`,
        "kept-cursor",
      );
    });

    await hub.ensurePolling();

    expect(await readState()).toMatchObject({
      status: "running",
      cursor: "kept-cursor",
    });
    expect(await pollSchedules()).toHaveLength(1);
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
    });

    const { calls, fetchImpl } = scriptedILink([
      jsonResponse({ message_id: "sent-1" }),
    ]);
    setILinkFetchOverride(fetchImpl);

    await channels().send(
      { channel: "wechat", conversationId: OWNER },
      { text: "reply" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://ilink.example/ilink/bot/sendmessage",
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
