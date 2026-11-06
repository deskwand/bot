import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setChannelOverride,
  setPollTimingOverride,
  setTelegramFetchOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import type { ChannelAdapter } from "../../src/channels/types";
import { readRuntimeConfig } from "../../src/runtime-config";
import {
  decodeAction,
  encodeAction,
  type InboundEvent,
  type MessageEvent,
} from "../../src/protocol";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const OWNER_ID = readRuntimeConfig(
  env as unknown as Env,
).owner.telegramUserIds[0]!;

type TelegramStateRow = {
  token_hash: string | null;
  offset: number;
  status: string | null;
  last_poll_at: number | null;
  expired_version: string | null;
};

type RecordedCall = {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
};

type Reply = { body: unknown; status?: number };

function jsonResponse(body: unknown, status = 200): Reply {
  return { body, status };
}

function scriptedTelegram(responses: Array<Reply | Error> = []) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // A poll chain leaked from an earlier test must not consume this test's
    // scripted responses: its old token gets the same answer Telegram would.
    if (!url.includes(`/bot${telegramToken}/`)) {
      return new Response(
        JSON.stringify({ ok: false, description: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });

    const next = responses.shift();
    if (!next) {
      // Exhausted: a slow empty batch stops the run without spinning.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function telegramMessage(updateId: number, text = "hi") {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: OWNER_ID },
      chat: { id: 42 },
      text,
    },
  };
}

function inboundMessage(updateId: number): InboundEvent {
  return {
    type: "message",
    channel: "telegram",
    chatId: "42",
    userId: String(OWNER_ID),
    text: "hi",
    eventId: `tg:${updateId}`,
  };
}

function methodOf(call: RecordedCall): string {
  return call.url.split("/").pop() ?? "";
}

let hubName = "channels";
let hubCounter = 0;
let telegramToken = "123:test";

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

function readState(): Promise<TelegramStateRow | null> {
  return runInDurableObject(channels(), (_instance, state) => {
    return (
      state.storage.sql
        .exec<TelegramStateRow>(
          `SELECT token_hash, offset, status, last_poll_at, expired_version
           FROM telegram_state WHERE id = 1`,
        )
        .toArray()[0] ?? null
    );
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
      (schedule) => schedule.callback === "pollTelegram",
    );
  });
}

async function pollThroughDO(): Promise<number> {
  return runInDurableObject(channels(), async (instance) => {
    const target = instance as unknown as {
      pollTelegram(): Promise<void>;
      listSchedules(): Promise<{ id: string; callback: string }[]>;
      cancelSchedule(id: string): Promise<boolean>;
    };
    await target.pollTelegram();
    const schedules = (await target.listSchedules()).filter(
      (schedule) => schedule.callback === "pollTelegram",
    );
    for (const schedule of schedules) {
      await target.cancelSchedule(schedule.id);
    }
    return schedules.length;
  });
}

/** Drops the instance's cached route, as a redeploy would. */
async function reloadRoute(): Promise<void> {
  await runInDurableObject(channels(), (instance) => {
    (instance as unknown as { routePromise?: unknown }).routePromise = undefined;
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

type ChannelEvent = {
  deskwand: string;
  channel: string;
  event: string;
  errorCode?: string;
};

function captureConsole(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });
  return lines;
}

function channelEvents(lines: string[]): ChannelEvent[] {
  const events: ChannelEvent[] = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as Partial<ChannelEvent>;
      if (value.deskwand === "channel_event") events.push(value as ChannelEvent);
    } catch {
      // Not a structured event line.
    }
  }
  return events;
}

function fakeAdapter(
  parse: (update: unknown) => Promise<InboundEvent | null>,
): ChannelAdapter {
  return {
    parseInbound: parse,
    send: async () => ({ messageId: "" }),
    edit: async () => {},
    async sendArtifact() {},
    answerAction: async () => {},
  };
}

beforeEach(async () => {
  hubName = `telegram-poll-${++hubCounter}`;
  telegramToken = `123:test-${hubCounter}`;
  setEnv({ TELEGRAM_BOT_TOKEN: telegramToken, ACTIVE_CHANNEL: "telegram" });
  // Install the test-only overrides before the DO is first constructed: its
  // onStart calls ensurePolling, which must not start a real polling chain.
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  setTelegramFetchOverride(scriptedTelegram().fetchImpl);
  setPollTimingOverride({ runMs: 0, baseBackoffMs: 1, manualStart: true });
  setWeChatCredentialsOverride(null);
  await cancelSchedules();
  await runInDurableObject(channels(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM owner_addresses");
    state.storage.sql.exec("DELETE FROM telegram_state");
  });
});

afterEach(async () => {
  for (const restore of restores.splice(0)) await restore();
  await cancelSchedules();
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  // Answer any chain that is still scheduled after the test with an invalid
  // token, so it stops instead of reaching the real Bot API.
  setTelegramFetchOverride(
    (async () =>
      new Response(
        JSON.stringify({ ok: false, description: "Unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      )) as typeof fetch,
  );
  setPollTimingOverride(null);
  setWeChatCredentialsOverride(null);
  restoreEnv();
  vi.restoreAllMocks();
});

describe("ensurePolling", () => {
  it("does nothing without a token", async () => {
    setEnv({ TELEGRAM_BOT_TOKEN: undefined });
    const { calls, fetchImpl } = scriptedTelegram();
    setTelegramFetchOverride(fetchImpl);

    await channels().ensurePolling();

    expect(await pollSchedules()).toEqual([]);
    expect(await readState()).toBeNull();
    expect(calls).toEqual([]);
  });

  it("starts one chain and does not duplicate it", async () => {
    // This test exercises the initial schedule, so allow the automatic start.
    setPollTimingOverride({ runMs: 0, baseBackoffMs: 1 });

    await channels().ensurePolling();

    const first = await pollSchedules();
    expect(first).toHaveLength(1);
    expect(await readState()).toMatchObject({ status: "running", offset: 0 });

    await channels().ensurePolling();

    expect(await pollSchedules()).toHaveLength(1);
    await cancelSchedules();
  });

  it("restarts a dead chain once the heartbeat is stale", async () => {
    // Warm the row without scheduling, then drive ensurePolling for real.
    await channels().ensurePolling();
    await cancelSchedules();
    setPollTimingOverride({ runMs: 0, baseBackoffMs: 1 });
    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE telegram_state SET status = 'running', last_poll_at = ?`,
        Date.now(),
      );
    });

    await channels().ensurePolling();
    expect(await pollSchedules()).toEqual([]);

    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE telegram_state SET last_poll_at = ?`,
        Date.now() - 121_000,
      );
    });
    await channels().ensurePolling();
    expect(await pollSchedules()).toHaveLength(1);
    await cancelSchedules();
  });
});

describe("pollTelegram", () => {
  it("makes one long poll per invocation and hands off, so a redeploy is never stranded in an old run", async () => {
    await channels().ensurePolling();
    await cancelSchedules();
    // Production timing: no runMs override.
    setPollTimingOverride(null);

    let polls = 0;
    setTelegramFetchOverride((async () => {
      polls += 1;
      // A second long poll in the same invocation means the run kept going.
      // Rotate the token so that run ends instead of spinning.
      if (polls > 1) setEnv({ TELEGRAM_BOT_TOKEN: `${telegramToken}-rotated` });
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    const scheduled = await pollThroughDO();

    expect(polls).toBe(1);
    expect(scheduled).toBe(1);
  });

  it("dispatches owner messages and stores the offset", async () => {
    const lines = captureConsole();
    const noise: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args) => {
      noise.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args) => {
      noise.push(args.map((arg) => String(arg)).join(" "));
    });
    await channels().ensurePolling();
    await cancelSchedules();
    const { calls, fetchImpl } = scriptedTelegram([
      jsonResponse({ ok: true, result: [telegramMessage(7)] }),
    ]);
    setTelegramFetchOverride(fetchImpl);
    const events = await captureButler();

    const scheduled = await pollThroughDO();
    expect(scheduled).toBe(1);

    const route = await channels().currentRoute();
    await vi.waitFor(() => {
      expect(events).toEqual([
        {
          type: "message",
          channel: "telegram",
          chatId: "42",
          userId: String(OWNER_ID),
          text: "hi",
          eventId: "tg:7",
          routeKey: route.routeKey,
        },
      ]);
    });

    expect(calls[0]?.body).toEqual({
      offset: 0,
      timeout: 25,
      allowed_updates: ["message", "callback_query"],
    });
    expect((await readState())?.offset).toBe(8);
    expect(
      channelEvents(lines).some((event) => event.event === "poll_ok"),
    ).toBe(true);
    expect([...lines, ...noise].some((line) => line.includes(telegramToken))).toBe(
      false,
    );
  });

  it("skips an update that cannot be parsed", async () => {
    const lines = captureConsole();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setChannelOverride(
      "telegram",
      fakeAdapter(async (update) => {
        const parsed = update as { update_id: number };
        if (parsed.update_id === 8) throw new Error("bad update");
        return inboundMessage(parsed.update_id);
      }),
    );
    await channels().ensurePolling();
    await cancelSchedules();
    const scripted = scriptedTelegram([
      jsonResponse({
        ok: true,
        result: [telegramMessage(7), telegramMessage(8)],
      }),
    ]);
    setTelegramFetchOverride(scripted.fetchImpl);
    const events = await captureButler();

    await pollThroughDO();

    await vi.waitFor(() => {
      expect(events.map((event) => event.eventId)).toEqual(["tg:7"]);
    });
    expect((await readState())?.offset).toBe(9);
    const emitted = channelEvents(lines);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "telegram",
          event: "webhook_rejected",
          errorCode: "payload_invalid",
        }),
      ]),
    );
    expect(emitted.some((event) => event.event === "poll_error")).toBe(false);
  });

  it("keeps the offset when maintenance lands while an update is parsing", async () => {
    await channels().ensurePolling();
    await cancelSchedules();
    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec("UPDATE telegram_state SET offset = 7");
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parsed = false;
    setChannelOverride(
      "telegram",
      fakeAdapter(async (update) => {
        const { update_id: updateId } = update as { update_id: number };
        if (updateId === 7) {
          parsed = true;
          await gate;
        }
        return inboundMessage(updateId);
      }),
    );
    setTelegramFetchOverride(
      scriptedTelegram([
        jsonResponse({
          ok: true,
          result: [telegramMessage(7), telegramMessage(8)],
        }),
      ]).fetchImpl,
    );
    const events = await captureButler();

    await runInDurableObject(channels(), async (instance) => {
      const pending = instance.pollTelegram();
      await vi.waitFor(() => expect(parsed).toBe(true));
      await instance.acquireMaintenance("export", "op-batch-7");
      release();
      await pending;
      for (const schedule of await instance.listSchedules()) {
        await instance.cancelSchedule(schedule.id);
      }
    });

    expect((await readState())?.offset).toBe(7);
    expect(await pollSchedules()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("advances only the accepted update when maintenance lands mid-batch", async () => {
    await channels().ensurePolling();
    await cancelSchedules();
    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec("UPDATE telegram_state SET offset = 7");
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parsed = false;
    setChannelOverride(
      "telegram",
      fakeAdapter(async (update) => {
        const { update_id: updateId } = update as { update_id: number };
        if (updateId === 8) {
          parsed = true;
          await gate;
        }
        return inboundMessage(updateId);
      }),
    );
    setTelegramFetchOverride(
      scriptedTelegram([
        jsonResponse({
          ok: true,
          result: [telegramMessage(7), telegramMessage(8)],
        }),
      ]).fetchImpl,
    );
    const events = await captureButler();

    await runInDurableObject(channels(), async (instance) => {
      const pending = instance.pollTelegram();
      await vi.waitFor(() => expect(parsed).toBe(true));
      await instance.acquireMaintenance("export", "op-batch-8");
      release();
      await pending;
      for (const schedule of await instance.listSchedules()) {
        await instance.cancelSchedule(schedule.id);
      }
    });

    expect((await readState())?.offset).toBe(8);
    expect(await pollSchedules()).toEqual([]);
    expect(events.map((event) => event.eventId)).toEqual(["tg:7"]);
  });

  it("routes a button through the poll loop", async () => {
    const answered: Array<{ actionId: string; text?: string }> = [];
    setChannelOverride("telegram", {
      parseInbound: async (update) => {
        const parsed = update as {
          update_id: number;
          callback_query: {
            id: string;
            from: { id: number };
            data: string;
            message: { message_id: number; chat: { id: number } };
          };
        };
        const query = parsed.callback_query;
        const decoded = decodeAction(query.data);
        if (!decoded) return null;
        return {
          type: "action",
          channel: "telegram",
          chatId: String(query.message.chat.id),
          userId: String(query.from.id),
          actionId: query.id,
          messageId: String(query.message.message_id),
          action: decoded.action,
          taskId: decoded.taskId,
          eventId: `tg:${parsed.update_id}`,
        };
      },
      send: async () => ({ messageId: "" }),
      edit: async () => {},
      async sendArtifact() {},
      answerAction: async (actionId, text) => {
        answered.push({ actionId, ...(text === undefined ? {} : { text }) });
      },
    });
    await channels().ensurePolling();
    await cancelSchedules();
    setTelegramFetchOverride(
      scriptedTelegram([
        jsonResponse({
          ok: true,
          result: [
            {
              update_id: 9,
              callback_query: {
                id: "cb-1",
                from: { id: OWNER_ID },
                data: encodeAction({ action: "cancel", taskId: "task-cb" }),
                message: { message_id: 5, chat: { id: 42 } },
              },
            },
          ],
        }),
      ]).fetchImpl,
    );

    await pollThroughDO();

    expect(answered[0]?.actionId).toBe("cb-1");
    expect((await readState())?.offset).toBe(10);
  });

  it("accepts an update when dispatch fails without a lease", async () => {
    setChannelOverride("telegram", fakeAdapter(async () => inboundMessage(3)));
    await channels().ensurePolling();

    const result = await runInDurableObject(channels(), async (instance) => {
      const target = instance as unknown as {
        dispatchMessage(): boolean;
        handleTelegramUpdate(update: unknown): Promise<string>;
      };
      const original = target.dispatchMessage;
      target.dispatchMessage = () => false;
      try {
        return await target.handleTelegramUpdate({ update_id: 3 });
      } finally {
        target.dispatchMessage = original;
      }
    });

    expect(result).toBe("accepted");
  });

  it("keeps the offset while maintenance holds", async () => {
    await channels().ensurePolling();
    await cancelSchedules();
    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec("UPDATE telegram_state SET offset = 5");
    });
    const { calls, fetchImpl } = scriptedTelegram([
      jsonResponse({ ok: true, result: [telegramMessage(7)] }),
    ]);
    setTelegramFetchOverride(fetchImpl);

    await channels().acquireMaintenance("export", "op-fence");

    expect(await pollThroughDO()).toBe(0);

    expect(calls).toEqual([]);
    expect((await readState())?.offset).toBe(5);
    expect(await pollSchedules()).toEqual([]);
  });

  it("recovers from a registered webhook", async () => {
    await channels().ensurePolling();
    await cancelSchedules();
    const conflict = jsonResponse(
      {
        ok: false,
        error_code: 409,
        description:
          "Conflict: can't use getUpdates method while webhook is active",
      },
      409,
    );
    const { calls, fetchImpl } = scriptedTelegram([
      conflict,
      jsonResponse({ ok: true, result: true }),
      jsonResponse({ ok: true, result: [telegramMessage(7)] }),
    ]);
    setTelegramFetchOverride(fetchImpl);
    const events = await captureButler();

    await pollThroughDO();

    expect(calls.map(methodOf)).toEqual([
      "getUpdates",
      "deleteWebhook",
      "getUpdates",
    ]);
    expect(calls[1]?.body).toEqual({});
    await vi.waitFor(() => {
      expect(events.map((event) => event.eventId)).toEqual(["tg:7"]);
    });
    expect((await readState())?.offset).toBe(8);
  });

  it("backs off on a repeated conflict", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lines = captureConsole();
    setPollTimingOverride({ runMs: 200, baseBackoffMs: 2, manualStart: true });
    await channels().ensurePolling();
    await cancelSchedules();
    const conflict = jsonResponse(
      {
        ok: false,
        error_code: 409,
        description:
          "Conflict: can't use getUpdates method while webhook is active",
      },
      409,
    );
    const { calls, fetchImpl } = scriptedTelegram([
      conflict,
      jsonResponse({ ok: true, result: true }),
      conflict,
      jsonResponse({ ok: true, result: [telegramMessage(7)] }),
    ]);
    setTelegramFetchOverride(fetchImpl);
    const events = await captureButler();

    await pollThroughDO();

    expect(
      calls.filter((call) => methodOf(call) === "deleteWebhook"),
    ).toHaveLength(1);
    expect(channelEvents(lines)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "telegram",
          event: "poll_error",
          errorCode: "api_error",
        }),
      ]),
    );
    await vi.waitFor(() => {
      expect(events.map((event) => event.eventId)).toEqual(["tg:7"]);
    });
  });

  it("stops on an invalid token", async () => {
    const lines = captureConsole();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await channels().ensurePolling();
    await cancelSchedules();
    setTelegramFetchOverride(
      scriptedTelegram([
        jsonResponse({ ok: false, description: "Unauthorized" }, 401),
      ]).fetchImpl,
    );

    expect(await pollThroughDO()).toBe(0);

    expect(await readState()).toMatchObject({
      status: "expired",
      offset: 0,
    });
    expect(
      channelEvents(lines).some(
        (event) =>
          event.event === "poll_expired" &&
          event.errorCode === "credential_invalid",
      ),
    ).toBe(true);

    setPollTimingOverride({ runMs: 0, baseBackoffMs: 1 });
    await channels().ensurePolling();
    await channels().ensurePolling();
    expect(await pollSchedules()).toEqual([]);
    // Same deployable version: the rejection stands.
    expect(await readState()).toMatchObject({ status: "expired" });
  });

  it("stops on a 404 token response", async () => {
    const lines = captureConsole();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await channels().ensurePolling();
    await cancelSchedules();
    setTelegramFetchOverride(
      scriptedTelegram([
        jsonResponse({ ok: false, description: "Not Found" }, 404),
      ]).fetchImpl,
    );

    expect(await pollThroughDO()).toBe(0);

    expect(await readState()).toMatchObject({ status: "expired", offset: 0 });
    expect(
      channelEvents(lines).some(
        (event) =>
          event.event === "poll_expired" &&
          event.errorCode === "credential_invalid",
      ),
    ).toBe(true);

    setPollTimingOverride({ runMs: 0, baseBackoffMs: 1 });
    await channels().ensurePolling();
    expect(await pollSchedules()).toEqual([]);
  });

  it("retries an expired token after a redeploy", async () => {
    await channels().ensurePolling();
    await cancelSchedules();
    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE telegram_state
           SET status = 'expired', offset = 9, expired_version = 'old'`,
      );
    });

    setEnv({ CF_VERSION_METADATA: { id: "new" } });
    await channels().ensurePolling();

    expect(await readState()).toMatchObject({
      status: "running",
      offset: 9,
      expired_version: null,
    });
  });

  it("restarts with a new token", async () => {
    await channels().ensurePolling();
    await cancelSchedules();
    // End state of "stops on an invalid token": the old token was rejected.
    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE telegram_state SET status = 'expired', offset = 9",
      );
    });
    expect(await readState()).toMatchObject({ status: "expired", offset: 9 });

    setEnv({ TELEGRAM_BOT_TOKEN: "456:other" });
    // manualStart only suppresses the zero-delay schedule, so no live chain
    // can race this test.
    await channels().ensurePolling();

    expect(await readState()).toMatchObject({ status: "running", offset: 0 });
  });

  it("backs off after a 5xx and keeps polling", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lines = captureConsole();
    setPollTimingOverride({ runMs: 200, baseBackoffMs: 2, manualStart: true });
    await channels().ensurePolling();
    await cancelSchedules();
    setTelegramFetchOverride(
      scriptedTelegram([
        jsonResponse({ description: "server down" }, 502),
        jsonResponse({ ok: true, result: [telegramMessage(7)] }),
      ]).fetchImpl,
    );
    const events = await captureButler();

    await pollThroughDO();

    await vi.waitFor(() => {
      expect(events.map((event) => event.eventId)).toEqual(["tg:7"]);
    });
    expect(channelEvents(lines)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "telegram",
          event: "poll_error",
          errorCode: "upstream_error",
        }),
      ]),
    );
    expect((await readState())?.status).toBe("running");
  });

  it("stops when WeChat is selected", async () => {
    // Let ensurePolling schedule the chain, so the switch has one to cancel.
    setPollTimingOverride({ runMs: 0, baseBackoffMs: 1 });
    await channels().ensurePolling();
    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec("UPDATE telegram_state SET offset = 12");
    });
    expect(await pollSchedules()).toHaveLength(1);
    const hub = channels();

    setEnv({ ACTIVE_CHANNEL: "wechat" });
    await reloadRoute();
    await hub.ensurePolling();

    expect(await pollSchedules()).toEqual([]);
    expect(await readState()).toMatchObject({
      status: "stopped",
      offset: 12,
    });

    setEnv({ ACTIVE_CHANNEL: "telegram" });
    await reloadRoute();
    await hub.ensurePolling();

    expect(await readState()).toMatchObject({
      status: "running",
      offset: 12,
    });
  });
});
