import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setChannelOverride,
  setILinkFetchOverride,
  setPollTimingOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import { createTelegramAdapter } from "../../src/channels/telegram";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const OWNER = "wx-events-owner";
const TOKEN_SENTINEL = "TOKEN-SENTINEL-never-log";
const CREDS = {
  token: TOKEN_SENTINEL,
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "account-events",
  userId: OWNER,
};

type ChannelEvent = {
  deskwand: string;
  v: number;
  versionId: string;
  channel: string;
  event: string;
  errorCode?: string;
  at: string;
};

type Reply = { body: unknown; status?: number };

function jsonResponse(body: unknown, status = 200): Reply {
  return { body, status };
}

function scriptedILink(responses: Array<Reply | Error> = []) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const next = responses.shift() ?? jsonResponse({});
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

let hubCounter = 0;
let hubName = "";

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName(hubName));
}

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

beforeEach(async () => {
  hubName = `channel-events-${++hubCounter}`;
  setEnv({ ACTIVE_CHANNEL: "wechat" });
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
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
  await cancelSchedules();
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  setILinkFetchOverride(null);
  setPollTimingOverride(null);
  setWeChatCredentialsOverride(null);
  restoreEnv();
  vi.restoreAllMocks();
});

describe("channel event wiring", () => {
  it("emits poll_ok only after a real getUpdates response", async () => {
    const lines = captureConsole();
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    await channels().ensurePolling();
    await cancelSchedules();

    expect(channelEvents(lines)).toEqual([]);

    const { calls, fetchImpl } = scriptedILink([
      jsonResponse({ get_updates_buf: "cursor-ok", msgs: [] }),
    ]);
    setILinkFetchOverride(fetchImpl);

    await pollThroughDO();

    expect(calls).toHaveLength(1);
    const events = channelEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      deskwand: "channel_event",
      v: 1,
      versionId: (env as unknown as Env).CF_VERSION_METADATA.id,
      channel: "wechat",
      event: "poll_ok",
    });
    expect(events[0]).not.toHaveProperty("errorCode");
    expect(lines.join("\n")).not.toContain(TOKEN_SENTINEL);
  });

  it("emits poll_expired when getUpdates reports an expired session", async () => {
    const lines = captureConsole();
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    await channels().ensurePolling();
    await cancelSchedules();
    setILinkFetchOverride(
      scriptedILink([jsonResponse({ errcode: -14, errmsg: "expired" })])
        .fetchImpl,
    );

    await pollThroughDO();

    const events = channelEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channel: "wechat",
      event: "poll_expired",
      errorCode: "session_expired",
    });
    expect(lines.join("\n")).not.toContain(TOKEN_SENTINEL);
  });

  it("emits poll_error for a non-expiry poll failure", async () => {
    const lines = captureConsole();
    vi.spyOn(console, "error").mockImplementation(() => {});
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    await channels().ensurePolling();
    await cancelSchedules();
    setILinkFetchOverride(
      scriptedILink([jsonResponse({ errmsg: "server down" }, 500)]).fetchImpl,
    );

    await pollThroughDO();

    const events = channelEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channel: "wechat",
      event: "poll_error",
      errorCode: "upstream_error",
    });
  });

  it("does not emit poll_ok on the heartbeat-only path", async () => {
    const lines = captureConsole();
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    await channels().ensurePolling();
    await cancelSchedules();
    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE wechat_state SET last_poll_at = ?`,
        Date.now(),
      );
    });
    const { calls, fetchImpl } = scriptedILink([
      jsonResponse({ get_updates_buf: "must-not-run", msgs: [] }),
    ]);
    setILinkFetchOverride(fetchImpl);

    await channels().ensurePolling();

    expect(calls).toEqual([]);
    expect(channelEvents(lines)).toEqual([]);
  });

  it("emits webhook_rejected only for a malformed Telegram update", async () => {
    const lines = captureConsole();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setChannelOverride(
      "telegram",
      createTelegramAdapter({ token: "123:test" }),
    );

    await channels().handleTelegramUpdate("not-an-object");

    const events = channelEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channel: "telegram",
      event: "webhook_rejected",
      errorCode: "payload_invalid",
    });
  });

  it("does not emit webhook_rejected for ignored updates or non-owners", async () => {
    const lines = captureConsole();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setChannelOverride(
      "telegram",
      createTelegramAdapter({ token: "123:test" }),
    );

    await channels().handleTelegramUpdate({
      update_id: 2,
      edited_message: {},
    });
    await channels().handleTelegramUpdate({
      update_id: 3,
      message: {
        message_id: 2,
        from: { id: 999 },
        chat: { id: 42 },
        text: "hi",
      },
    });

    expect(channelEvents(lines)).toEqual([]);
  });

  it("emits send_ok only after a successful send", async () => {
    const lines = captureConsole();
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    await runInDurableObject(channels(), (_instance, state) => {
      // Earlier cases in this file leave rejected sends queued; this case
      // measures the events of a single send.
      state.storage.sql.exec("DELETE FROM outbound_queue");
      state.storage.sql.exec(
        `INSERT INTO wechat_contexts (user_id, context_token, updated_at)
         VALUES (?, ?, ?)`,
        OWNER,
        "ctx-events",
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES ('wechat', ?, ?)`,
        OWNER,
        Date.now(),
      );
    });

    expect(channelEvents(lines)).toEqual([]);

    setILinkFetchOverride(
      scriptedILink([jsonResponse({ message_id: "sent-1" })]).fetchImpl,
    );
    await channels().sendCurrent({ text: "reply" });

    const events = channelEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channel: "wechat",
      event: "send_ok",
    });
    expect(lines.join("\n")).not.toContain(TOKEN_SENTINEL);
  });
});
