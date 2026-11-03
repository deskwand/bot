import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setChannelOverride,
  setILinkFetchOverride,
  setPollTimingOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import type { ChannelMessageRef, RouteSnapshot } from "../../src/protocol";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const CREDS = {
  token: "token-a",
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "account-a",
  userId: "wx-owner",
};

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

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

let hubName = "";
let failSend = false;
let calls: Array<{ url: string; body: unknown }> = [];

/** An iLink stand-in: `failSend` makes sendmessage answer HTTP 500. */
function ilinkFetch() {
  return function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    });
    if (failSend && url.endsWith("/ilink/bot/sendmessage")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ errcode: 40001, errmsg: "send failed" }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }
    return Promise.resolve(
      new Response('{"ret":0}', {
        headers: { "content-type": "application/json" },
      }),
    );
  } as typeof fetch;
}

function hub() {
  return env.CHANNELS.get(env.CHANNELS.idFromName(hubName));
}

function queued() {
  return runInDurableObject(hub(), (_instance, state) =>
    state.storage.sql
      .exec<{ text: string; last_error: string | null }>(
        `SELECT text, last_error FROM outbound_queue ORDER BY id`,
      )
      .toArray(),
  );
}

function sentTexts(): string[] {
  return calls
    .filter((call) => call.url.endsWith("/ilink/bot/sendmessage"))
    .map(
      (call) =>
        (
          call.body as {
            msg: { item_list: { text_item: { text: string } }[] };
          }
        ).msg.item_list[0]!.text_item.text,
    );
}

function send(text: string): Promise<ChannelMessageRef> {
  return runInDurableObject(hub(), (instance) =>
    (
      instance as unknown as {
        sendCurrent(msg: { text: string }): Promise<ChannelMessageRef>;
      }
    ).sendCurrent({ text }),
  );
}

function flush(): Promise<void> {
  return runInDurableObject(hub(), (instance) =>
    (instance as unknown as { flushOutbound(): Promise<void> }).flushOutbound(),
  );
}

beforeEach(async () => {
  hubName = `send-queue-${crypto.randomUUID()}`;
  calls = [];
  failSend = false;
  setEnv({ ACTIVE_CHANNEL: "wechat" });
  setWeChatCredentialsOverride(JSON.stringify(CREDS));
  setChannelOverride("wechat", null);
  // Keep the poll chain out of these tests: starting it clears contexts when
  // the stored credentials hash is new to the object.
  setPollTimingOverride({ runMs: 0, baseBackoffMs: 1, manualStart: true });
  setILinkFetchOverride(ilinkFetch());
  // Boot the object before seeding: its first start clears stored contexts
  // when the credentials hash is new to it.
  await hub().currentRoute();
  await runInDurableObject(hub(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
       VALUES ('wechat', 'wx-owner', ?)
       ON CONFLICT(channel) DO UPDATE SET
         conversation_id = excluded.conversation_id`,
      Date.now(),
    );
    state.storage.sql.exec(
      `INSERT INTO wechat_contexts (user_id, context_token, updated_at)
       VALUES (?, ?, ?)`,
      "wx-owner",
      "ctx-1",
      Date.now(),
    );
  });
});

afterEach(() => {
  setPollTimingOverride(null);
  setILinkFetchOverride(null);
  setWeChatCredentialsOverride(null);
  setChannelOverride("wechat", null);
  restoreEnv();
});

describe("WeChat outbound queue", () => {
  it("keeps a rejected send queued and still returns a reference", async () => {
    failSend = true;
    const ref = await send("hello");

    expect(ref).toMatchObject({ channel: "wechat", messageId: null });
    expect(await queued()).toEqual([
      { text: "hello", last_error: "upstream_error" },
    ]);
  });

  it("clears the row once the channel accepts the send", async () => {
    await send("hello");

    expect(await queued()).toEqual([]);
    expect(sentTexts()).toEqual(["hello"]);
  });

  it("flushes the backlog in order", async () => {
    failSend = true;
    await send("first");
    await send("second");
    expect(await queued()).toHaveLength(2);

    failSend = false;
    calls = [];
    await flush();

    expect(await queued()).toEqual([]);
    expect(sentTexts()).toEqual(["first", "second"]);
  });

  it("flushes the backlog before sending a new message", async () => {
    failSend = true;
    await send("queued");
    failSend = false;
    calls = [];

    await send("fresh");

    expect(sentTexts()).toEqual(["queued", "fresh"]);
    expect(await queued()).toEqual([]);
  });

  it("flushes after an inbound message refreshes the context token", async () => {
    failSend = true;
    await send("late result");

    failSend = false;
    calls = [];
    await runInDurableObject(hub(), async (instance) => {
      const { routeKey } = await (
        instance as unknown as { currentRoute(): Promise<RouteSnapshot> }
      ).currentRoute();
      const proto = Object.getPrototypeOf(instance) as {
        dispatchMessage(event: unknown, routeKey: string): void;
      };
      const original = proto.dispatchMessage;
      proto.dispatchMessage = () => {};
      try {
        (
          instance as unknown as {
            dispatchWeChatUpdates(
              updates: unknown[],
              cursor: string,
              credentials: typeof CREDS,
              routeKey: string,
            ): void;
          }
        ).dispatchWeChatUpdates(
          [
            {
              messageId: "m2",
              fromUserId: "wx-owner",
              contextToken: "ctx-2",
              text: "hi",
              messageType: 1,
              voice: false,
            },
          ],
          "cursor-2",
          CREDS,
          routeKey,
        );
      } finally {
        proto.dispatchMessage = original;
      }
    });

    // The drain runs inside `ctx.waitUntil`, so wait for it to settle.
    await vi.waitFor(async () => {
      expect(await queued()).toEqual([]);
    });
    const tokens = calls
      .filter((call) => call.url.endsWith("/ilink/bot/sendmessage"))
      .map(
        (call) =>
          (call.body as { msg: { context_token: string } }).msg.context_token,
      );
    expect(tokens.at(-1)).toBe("ctx-2");
  });

  it("holds a send that has no context token yet until one arrives", async () => {
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM wechat_contexts");
    });

    await send("before first inbound");
    expect(await queued()).toEqual([
      { text: "before first inbound", last_error: "network_error" },
    ]);

    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO wechat_contexts (user_id, context_token, updated_at)
         VALUES ('wx-owner', 'ctx-9', ?)`,
        Date.now(),
      );
    });
    await flush();

    expect(await queued()).toEqual([]);
    expect(sentTexts()).toEqual(["before first inbound"]);
  });

  it("sends each queued message once when two flushes overlap", async () => {
    failSend = true;
    await send("only once");
    failSend = false;
    calls = [];

    await runInDurableObject(hub(), async (instance) => {
      const target = instance as unknown as {
        flushOutbound(): Promise<void>;
      };
      await Promise.all([target.flushOutbound(), target.flushOutbound()]);
    });

    expect(await queued()).toEqual([]);
    expect(sentTexts()).toEqual(["only once"]);
  });

  it("stops the queue at the first failure and keeps the order", async () => {
    failSend = true;
    await send("first");
    failSend = false;
    calls = [];

    // The head still fails while the tail could succeed.
    const ilink = ilinkFetch();
    setILinkFetchOverride(function (input: RequestInfo | URL, init?: RequestInit) {
      if (String(input).endsWith("/ilink/bot/sendmessage")) {
        return Promise.resolve(new Response("{}", { status: 500 }));
      }
      return ilink(input, init);
    } as typeof fetch);
    await send("second");

    // `second` must wait behind `first` instead of jumping the queue.
    expect(await queued()).toHaveLength(2);
    expect(sentTexts()).toEqual([]);

    setILinkFetchOverride(ilinkFetch());
    calls = [];
    await flush();
    expect(sentTexts()).toEqual(["first", "second"]);
  });

  it("drops a row that keeps failing so later messages still go out", async () => {
    failSend = true;
    await send("poison");
    for (let attempt = 0; attempt < 5; attempt++) await flush();
    // The row is given up on rather than blocking the queue forever.
    expect(await queued()).toEqual([]);

    failSend = false;
    calls = [];
    await send("after");

    expect(sentTexts()).toEqual(["after"]);
    expect(await queued()).toEqual([]);
  });

  it("sends through a corrupt queued row instead of wedging the queue", async () => {
    failSend = true;
    await send("corrupt me");
    failSend = false;
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE outbound_queue SET buttons_json = 'not json'`,
      );
    });
    calls = [];

    await send("fresh");

    expect(sentTexts()).toEqual(["corrupt me", "fresh"]);
    expect(await queued()).toEqual([]);
  });

  it("does not flush WeChat rows once the channel selection moves away", async () => {
    failSend = true;
    await send("for wechat");

    // A fresh instance resolves the new selection; routes are cached per DO.
    hubName = `send-queue-${crypto.randomUUID()}`;
    setEnv({ ACTIVE_CHANNEL: "telegram" });
    await runInDurableObject(hub(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO outbound_queue
           (conversation_id, text, buttons_json, last_error, created_at)
         VALUES ('wx-owner', 'for wechat', NULL, 'upstream_error', ?)`,
        Date.now(),
      );
    });
    calls = [];
    await flush();

    expect(calls.filter((call) => call.url.endsWith("/sendmessage"))).toEqual(
      [],
    );
    expect(await queued()).toHaveLength(1);
  });
});
