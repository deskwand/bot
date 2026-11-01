import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelDO } from "../../src/channels/channel-do";
import {
  setChannelOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import type { ChannelAdapter } from "../../src/channels/types";
import { config } from "../../src/config";
import type {
  ActionEvent,
  InboundEvent,
  MessageEvent,
  OutboundMessage,
} from "../../src/protocol";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const OWNER_ID = config.owner.telegramUserIds[0]!;
const SECRET = "s3cret";

const MESSAGE: MessageEvent = {
  type: "message",
  channel: "telegram",
  chatId: "42",
  userId: String(OWNER_ID),
  text: "hi",
  eventId: "tg:1",
};

const ACTION: ActionEvent = {
  type: "action",
  channel: "telegram",
  chatId: "42",
  userId: String(OWNER_ID),
  actionId: "cb-1",
  messageId: "9",
  action: "cancel",
  taskId: "action-ok",
  eventId: "tg:3",
};

type Sent = { to: string; msg: OutboundMessage };
type Edited = { to: string; messageId: string; msg: OutboundMessage };
type Answered = { actionId: string; text?: string };

function fakeAdapter(parse: (req: Request) => Promise<InboundEvent | null>) {
  const sent: Sent[] = [];
  const edits: Edited[] = [];
  const answered: Answered[] = [];

  const adapter: ChannelAdapter = {
    parseInbound: parse,
    async send(to, msg) {
      sent.push({ to, msg });
      return { messageId: String(sent.length) };
    },
    async edit(to, messageId, msg) {
      edits.push({ to, messageId, msg });
    },
    async answerAction(actionId, text) {
      answered.push({ actionId, ...(text === undefined ? {} : { text }) });
    },
  };

  return { adapter, sent, edits, answered };
}

function fakeTelegram(inbound: InboundEvent | null) {
  return fakeAdapter(async (req) =>
    req.headers.get("X-Telegram-Bot-Api-Secret-Token") === SECRET
      ? inbound
      : null,
  );
}

function webhook(secret = SECRET): Request {
  return new Request("https://example.com/telegram/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
  });
}

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

function freshChannels(name: string) {
  return env.CHANNELS.get(env.CHANNELS.idFromName(name));
}

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

/** Builds an independent, immutable-ish env fixture for one DO instance. */
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

function butler() {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

function task(taskId: string) {
  return env.TASK.get(env.TASK.idFromName(taskId));
}

function ownerAddresses() {
  return runInDurableObject(channels(), (_instance, state) =>
    state.storage.sql
      .exec<{ channel: string; conversation_id: string; updated_at: number }>(
        `SELECT channel, conversation_id, updated_at
         FROM owner_addresses ORDER BY channel`,
      )
      .toArray(),
  );
}

const restores: Array<() => Promise<void>> = [];

/** Replaces the Butler's RPC entry so the test can see the dispatched event. */
async function captureButler(
  hold?: Promise<void>,
): Promise<MessageEvent[]> {
  const events: MessageEvent[] = [];
  const stub = butler();
  let original:
    | ((evt: MessageEvent) => Promise<void>)
    | undefined;

  await runInDurableObject(stub, (instance) => {
    const proto = Object.getPrototypeOf(instance) as {
      handleMessage(evt: MessageEvent): Promise<void>;
    };
    original = proto.handleMessage;
    proto.handleMessage = async (evt) => {
      events.push(evt);
      if (hold) await hold;
    };
  });

  restores.push(async () => {
    await runInDurableObject(stub, (instance) => {
      const proto = Object.getPrototypeOf(instance) as {
        handleMessage(evt: MessageEvent): Promise<void>;
      };
      proto.handleMessage = original!;
    });
  });

  return events;
}

/** Makes the matching Task DO throw from `handleAction`. */
async function failTaskAction(taskId: string): Promise<void> {
  const stub = task(taskId);
  await runInDurableObject(stub, (instance) => {
    const proto = Object.getPrototypeOf(instance) as {
      handleAction(evt: ActionEvent): Promise<string>;
    };
    const original = proto.handleAction;
    proto.handleAction = async () => {
      throw new Error("boom");
    };
    restores.push(async () => {
      await runInDurableObject(stub, (restored) => {
        const restoredProto = Object.getPrototypeOf(restored) as {
          handleAction(evt: ActionEvent): Promise<string>;
        };
        restoredProto.handleAction = original;
      });
    });
  });
}

beforeEach(async () => {
  await runInDurableObject(channels(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM owner_addresses");
    state.storage.sql.exec("DELETE FROM wechat_state");
    state.storage.sql.exec("DELETE FROM wechat_contexts");
  });
});

afterEach(async () => {
  for (const restore of restores.splice(0)) await restore();
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  restoreEnv();
});

describe("handleTelegramWebhook", () => {
  it("ignores an update with the wrong webhook secret", async () => {
    const events = await captureButler();
    const tg = fakeTelegram(MESSAGE);
    setChannelOverride("telegram", tg.adapter);

    await channels().handleTelegramWebhook(webhook("wrong"));

    expect(events).toEqual([]);
    expect(await ownerAddresses()).toEqual([]);
  });

  it("ignores an update from a non-owner", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = await captureButler();
    const tg = fakeTelegram({ ...MESSAGE, userId: "999" });
    setChannelOverride("telegram", tg.adapter);

    await channels().handleTelegramWebhook(webhook());

    expect(events).toEqual([]);
    expect(await ownerAddresses()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("dispatches a message to the Butler and remembers the owner address", async () => {
    const events = await captureButler();
    const tg = fakeTelegram(MESSAGE);
    setChannelOverride("telegram", tg.adapter);

    await channels().handleTelegramWebhook(webhook());

    await vi.waitFor(() => {
      expect(events).toEqual([
        { ...MESSAGE, routeKey: expect.any(String) },
      ]);
    });
    expect(await ownerAddresses()).toMatchObject([
      { channel: "telegram", conversation_id: "42" },
    ]);
  });

  it("dispatches a non-text message with text null", async () => {
    const events = await captureButler();
    const nonText = { ...MESSAGE, text: null, eventId: "tg:2" };
    const tg = fakeTelegram(nonText);
    setChannelOverride("telegram", tg.adapter);

    await channels().handleTelegramWebhook(webhook());

    await vi.waitFor(() => {
      expect(events).toEqual([
        { ...nonText, routeKey: expect.any(String) },
      ]);
    });
  });

  it("does not wait for the Butler to finish", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events = await captureButler(hold);
    const tg = fakeTelegram(MESSAGE);
    setChannelOverride("telegram", tg.adapter);

    let outcome: unknown;
    try {
      outcome = await Promise.race([
        channels()
          .handleTelegramWebhook(webhook())
          .then(() => "returned"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
      ]);
    } finally {
      release();
    }

    expect(outcome).toBe("returned");
    await vi.waitFor(() => {
      expect(events).toEqual([
        { ...MESSAGE, routeKey: expect.any(String) },
      ]);
    });
  });

  it("does not throw when parsing the update fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tg = fakeAdapter(async () => {
      throw new Error("bad json");
    });
    setChannelOverride("telegram", tg.adapter);

    await expect(
      channels().handleTelegramWebhook(webhook()),
    ).resolves.toBeUndefined();
  });

  it("routes a button to the task and answers with its result", async () => {
    const tg = fakeTelegram(ACTION);
    setChannelOverride("telegram", tg.adapter);

    await channels().handleTelegramWebhook(webhook());

    expect(tg.answered).toEqual([
      { actionId: "cb-1", text: "任务尚未开始，无法取消" },
    ]);
  });

  it("answers with an error when handleAction throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const action = { ...ACTION, taskId: "action-error" };
    await failTaskAction(action.taskId);
    const tg = fakeTelegram(action);
    setChannelOverride("telegram", tg.adapter);

    await channels().handleTelegramWebhook(webhook());

    expect(tg.answered).toEqual([
      { actionId: "cb-1", text: "出错了，稍后再试" },
    ]);
  });

  it("does not throw when answering the callback fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tg = fakeTelegram(ACTION);
    tg.adapter.answerAction = async () => {
      throw new Error("telegram down");
    };
    setChannelOverride("telegram", tg.adapter);

    await expect(
      channels().handleTelegramWebhook(webhook()),
    ).resolves.toBeUndefined();
  });
});

describe("active channel gating", () => {
  it("ignores a Telegram message while WeChat is selected", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    const events = await captureButler();
    const tg = fakeTelegram(MESSAGE);
    setChannelOverride("telegram", tg.adapter);

    await freshChannels("gated-message").handleTelegramWebhook(webhook());

    expect(events).toEqual([]);
  });

  it("answers an old Telegram button as not enabled and runs no task", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    const events = await captureButler();
    const tg = fakeTelegram(ACTION);
    setChannelOverride("telegram", tg.adapter);

    await expect(
      freshChannels("gated-action").handleTelegramWebhook(webhook()),
    ).resolves.toBeUndefined();

    expect(events).toEqual([]);
    expect(tg.answered).toEqual([
      { actionId: "cb-1", text: "该渠道未启用" },
    ]);
  });

  it("re-enables the route after the selection returns to Telegram", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    const hub = freshChannels("gated-back");
    await hub.handleTelegramWebhook(webhook());

    setEnv({ ACTIVE_CHANNEL: "telegram" });
    await evictDurableObject(hub);
    const events = await captureButler();
    const tg = fakeTelegram(MESSAGE);
    setChannelOverride("telegram", tg.adapter);

    await hub.handleTelegramWebhook(webhook());

    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
  });
});

describe("sendCurrent", () => {
  it("falls back to the first Telegram owner when no address is stored", async () => {
    const tg = fakeTelegram(null);
    setChannelOverride("telegram", tg.adapter);

    const ref = await channels().sendCurrent({ text: "n" });

    expect(ref).toMatchObject({
      channel: "telegram",
      conversationId: String(OWNER_ID),
      messageId: "1",
      routeKey: expect.any(String),
    });
    expect(tg.sent).toEqual([
      { to: String(OWNER_ID), msg: { text: "n" } },
    ]);
  });

  it("uses the owner's latest conversation", async () => {
    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES (?, ?, ?)`,
        "telegram",
        "777",
        Date.now(),
      );
    });
    const tg = fakeTelegram(null);
    setChannelOverride("telegram", tg.adapter);

    const ref = await channels().sendCurrent({ text: "n" });

    expect(tg.sent).toEqual([{ to: "777", msg: { text: "n" } }]);
    expect(ref.conversationId).toBe("777");
  });

  it("downgrades buttons to text on a selected WeChat channel", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    const hub = freshChannels("send-wechat");
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES ('wechat', 'u1', ?)`,
        Date.now(),
      );
    });
    const sent: { to: string; msg: OutboundMessage }[] = [];
    setChannelOverride("wechat", {
      parseInbound: async () => null,
      async send(to, msg) {
        sent.push({ to, msg });
        return { messageId: "" };
  it("filters unsupported markdown for WeChat and keeps the hints", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    const hub = freshChannels("send-wechat-markdown");
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES ('wechat', 'u1', ?)`,
        Date.now(),
      );
    });
    const wx = fakeAdapter(async () => null);
    setChannelOverride("wechat", wx.adapter);

    await hub.sendCurrent({
      text: "**粗体** *中文斜体* ![图](https://example.com/a.png) 完毕",
      buttons: [[{ label: "取消", data: "a:cancel:t3" }]],
    });

    expect(wx.sent).toEqual([
      { to: "u1", msg: { text: '**粗体** 中文斜体  完毕\n回复"取消 t3"' } },
    ]);
  });

  it("sends Telegram markdown through unfiltered", async () => {
    setEnv({ ACTIVE_CHANNEL: "telegram" });
    const hub = freshChannels("send-telegram-markdown");
    const tg = fakeTelegram(null);
    setChannelOverride("telegram", tg.adapter);
    const markdown =
      "**粗体** *中文斜体* ![图](https://example.com/a.png)";

    await hub.sendCurrent({ text: markdown });

    expect(tg.sent).toEqual([{ to: String(OWNER_ID), msg: { text: markdown } }]);
  });
      },
      async edit() {},
      async answerAction() {},
    });

    const ref = await hub.sendCurrent({
      text: "x",
      buttons: [[{ label: "取消", data: "a:cancel:t3" }]],
    });

    expect(sent).toEqual([
      { to: "u1", msg: { text: 'x\n回复"取消 t3"' } },
    ]);
    expect(sent[0]?.msg.buttons).toBeUndefined();
    // WeChat has no message ids, but the send still succeeded.
    expect(ref).toMatchObject({ channel: "wechat", messageId: null });
  });

  it("does not fall back to Telegram when WeChat has no context", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    setWeChatCredentialsOverride(
      JSON.stringify({
        token: "token-a",
        baseUrl: "https://ilink.example",
        accountId: "account-a",
        userId: "u1",
      }),
    );
    const hub = freshChannels("send-wechat-no-context");
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES ('wechat', 'u1', ?)`,
        Date.now(),
      );
    });
    const tg = fakeTelegram(null);
    setChannelOverride("telegram", tg.adapter);

    const outcome = await runInDurableObject(hub, (instance) =>
      instance.sendCurrent({ text: "x" }).then(
        () => "sent",
        (error: Error) => error.message,
      ),
    );

    expect(outcome).toBe("wechat context missing");
    expect(tg.sent).toEqual([]);
    setWeChatCredentialsOverride(null);
  });

  it("keeps the approval id in the WeChat button hint", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    const hub = freshChannels("send-wechat-approval");
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES ('wechat', 'u1', ?)`,
        Date.now(),
      );
    });
    const sent: OutboundMessage[] = [];
    setChannelOverride("wechat", {
      parseInbound: async () => null,
      async send(_to, msg) {
        sent.push(msg);
        return { messageId: "" };
      },
      async edit() {},
      async answerAction() {},
    });

    await hub.sendCurrent({
      text: "🔐 t3 请求执行 web_fetch",
      buttons: [
        [
          { label: "✅ 批准", data: "a:approve:t3:ap1" },
          { label: "❌ 拒绝", data: "a:reject:t3:ap1" },
        ],
      ],
    });

    expect(sent[0]?.text).toContain('回复"批准 t3 ap1"');
    expect(sent[0]?.text).toContain('回复"拒绝 t3 ap1"');
  });

  it("refuses to send when the selection is invalid", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ACTIVE_CHANNEL: "slack" });
    const hub = freshChannels("send-invalid");
    const tg = fakeTelegram(null);
    setChannelOverride("telegram", tg.adapter);

    const outcome = await runInDurableObject(hub, (instance) =>
      instance.sendCurrent({ text: "n" }).then(
        () => "sent",
        (error: Error) => error.message,
      ),
    );
    expect(outcome).toBe("channel selection disabled");
    expect(tg.sent).toEqual([]);
  });
});

describe("editCurrent", () => {
  it("edits a reference owned by this deployment", async () => {
    const tg = fakeTelegram(null);
    setChannelOverride("telegram", tg.adapter);
    const hub = channels();

    const ref = await hub.sendCurrent({ text: "x" });
    const edited = await hub.editCurrent(ref, { text: "y" });

    expect(edited).toBe(true);
    expect(tg.edits).toEqual([
      { to: ref.conversationId, messageId: ref.messageId, msg: { text: "y" } },
    ]);
  });

  it("returns false for a WeChat reference", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    const hub = freshChannels("edit-wechat");
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES ('wechat', 'u1', ?)`,
        Date.now(),
      );
    });
    const wx = fakeAdapter(async () => null);
    setChannelOverride("wechat", wx.adapter);

    const ref = await hub.sendCurrent({ text: "x" });
    const edited = await hub.editCurrent(ref, { text: "y" });

    expect(edited).toBe(false);
    expect(wx.edits).toEqual([]);
  });

  it("rejects a reference issued by an older deployment", async () => {
    const tg = fakeTelegram(null);
    setChannelOverride("telegram", tg.adapter);
    const hub = channels();

    const result = await runInDurableObject(hub, async (instance, state) => {
      const base = env as unknown as Env;
      const older = new ChannelDO(state, {
        ...base,
        ACTIVE_CHANNEL: "telegram",
        CF_VERSION_METADATA: { id: "deploy-old" },
      } as Env);
      const ref = await older.sendCurrent({ text: "progress" });

      const newer = new ChannelDO(state, {
        ...base,
        ACTIVE_CHANNEL: "telegram",
        CF_VERSION_METADATA: { id: "deploy-new" },
      } as Env);
      const edited = await newer.editCurrent(ref, { text: "next" });
      return { ref, edited };
    });

    expect(result.ref.routeKey).toBeTypeOf("string");
    expect(result.edited).toBe(false);
    expect(tg.edits).toEqual([]);
  });

  it("does not edit a reference whose conversation moved", async () => {
    const tg = fakeTelegram(null);
    setChannelOverride("telegram", tg.adapter);
    const hub = channels();
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES ('telegram', '777', ?)`,
        Date.now(),
      );
    });

    const ref = await hub.sendCurrent({ text: "x" });
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE owner_addresses SET conversation_id = '888' WHERE channel = 'telegram'`,
      );
    });

    const edited = await hub.editCurrent(ref, { text: "y" });

    expect(edited).toBe(false);
    expect(tg.edits).toEqual([]);
  });
});
