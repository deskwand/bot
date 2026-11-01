import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
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
      expect(events).toEqual([MESSAGE]);
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
      expect(events).toEqual([nonText]);
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
      expect(events).toEqual([MESSAGE]);
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

describe("send", () => {
  it("resolves notify to the first Telegram owner when no address is stored", async () => {
    const tg = fakeTelegram(null);
    setChannelOverride("telegram", tg.adapter);

    const result = await channels().send("notify", { text: "n" });

    expect(result).toEqual({ messageId: "1" });
    expect(tg.sent).toEqual([
      { to: String(OWNER_ID), msg: { text: "n" } },
    ]);
  });

  it("resolves notify to the owner's latest conversation", async () => {
    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES (?, ?, ?)`,
        config.notifyChannel,
        "777",
        Date.now(),
      );
    });
    const tg = fakeTelegram(null);
    setChannelOverride("telegram", tg.adapter);

    await channels().send("notify", { text: "n" });

    expect(tg.sent).toEqual([{ to: "777", msg: { text: "n" } }]);
  });

  it("downgrades buttons to text for WeChat", async () => {
    const wx = fakeAdapter(async () => null);
    setChannelOverride("wechat", wx.adapter);

    await channels().send(
      { channel: "wechat", conversationId: "u1" },
      {
        text: "x",
        buttons: [[{ label: "取消", data: "a:cancel:t3" }]],
      },
    );

    expect(wx.sent).toEqual([
      { to: "u1", msg: { text: 'x\n回复"取消 t3"' } },
    ]);
    expect(wx.sent[0]?.msg.buttons).toBeUndefined();
  });
});

describe("edit", () => {
  it("returns false for WeChat", async () => {
    const wx = fakeAdapter(async () => null);
    setChannelOverride("wechat", wx.adapter);

    const edited = await channels().edit(
      { channel: "wechat", conversationId: "u1" },
      "m1",
      { text: "y" },
    );

    expect(edited).toBe(false);
    expect(wx.edits).toEqual([]);
  });
});
