import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelDO } from "../../src/channels/channel-do";
import {
  setChannelOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import type { ChannelAdapter } from "../../src/channels/types";
import { ILinkError } from "../../src/channels/wechat/ilink";
import { readRuntimeConfig } from "../../src/runtime-config";
import type {
  ActionEvent,
  InboundEvent,
  MessageEvent,
  OutboundMessage,
} from "../../src/protocol";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const OWNER_ID = readRuntimeConfig(
  env as unknown as Env,
).owner.telegramUserIds[0]!;

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

function fakeAdapter(parse: (update: unknown) => Promise<InboundEvent | null>) {
  const sent: Sent[] = [];
  const edits: Edited[] = [];
  const answered: Answered[] = [];
  const artifacts: { to: string; name: string; contentType: string }[] = [];

  const adapter: ChannelAdapter = {
    parseInbound: parse,
    async send(to, msg) {
      sent.push({ to, msg });
      return { messageId: String(sent.length) };
    },
    async edit(to, messageId, msg) {
      edits.push({ to, messageId, msg });
    },
    async sendArtifact(to, file) {
      artifacts.push({ to, name: file.name, contentType: file.contentType });
    },
    async answerAction(actionId, text) {
      answered.push({ actionId, ...(text === undefined ? {} : { text }) });
    },
  };

  return { adapter, sent, edits, answered, artifacts };
}

function fakeTelegram(inbound: InboundEvent | null) {
  return fakeAdapter(async () => inbound);
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

describe("handleTelegramUpdate", () => {
  it("ignores an update from a non-owner", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = await captureButler();
    const tg = fakeTelegram({ ...MESSAGE, userId: "999" });
    setChannelOverride("telegram", tg.adapter);

    await channels().handleTelegramUpdate({ update_id: 1 });

    expect(events).toEqual([]);
    expect(await ownerAddresses()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("dispatches a message to the Butler and remembers the owner address", async () => {
    const events = await captureButler();
    const tg = fakeTelegram(MESSAGE);
    setChannelOverride("telegram", tg.adapter);

    await channels().handleTelegramUpdate({ update_id: 1 });

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

    await channels().handleTelegramUpdate({ update_id: 1 });

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
          .handleTelegramUpdate({ update_id: 1 })
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
      channels().handleTelegramUpdate({ update_id: 1 }),
    ).resolves.toBe("accepted");
  });

  it("routes a button to the task and answers with its result", async () => {
    const tg = fakeTelegram(ACTION);
    setChannelOverride("telegram", tg.adapter);

    await channels().handleTelegramUpdate({ update_id: 1 });

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

    await channels().handleTelegramUpdate({ update_id: 1 });

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
      channels().handleTelegramUpdate({ update_id: 1 }),
    ).resolves.toBe("accepted");
  });

  it("fails business processing with a fixed error when config is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = await captureButler();
    const tg = fakeTelegram(MESSAGE);
    setChannelOverride("telegram", tg.adapter);
    setEnv({ DESKWAND_CONFIG: undefined });

    await channels().handleTelegramUpdate({ update_id: 1 });

    expect(events).toEqual([]);
    expect(await ownerAddresses()).toEqual([]);
    expect(error.mock.calls.flat().join(" ")).toContain("CONFIG_MISSING");
    error.mockRestore();
  });
});

describe("active channel gating", () => {
  it("ignores a Telegram message while WeChat is selected", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    const events = await captureButler();
    const tg = fakeTelegram(MESSAGE);
    setChannelOverride("telegram", tg.adapter);

    await freshChannels("gated-message").handleTelegramUpdate({ update_id: 1 });

    expect(events).toEqual([]);
  });

  it("answers an old Telegram button as not enabled and runs no task", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    const events = await captureButler();
    const tg = fakeTelegram(ACTION);
    setChannelOverride("telegram", tg.adapter);

    await expect(
      freshChannels("gated-action").handleTelegramUpdate({ update_id: 1 }),
    ).resolves.toBe("accepted");

    expect(events).toEqual([]);
    expect(tg.answered).toEqual([
      { actionId: "cb-1", text: "该渠道未启用" },
    ]);
  });

  it("re-enables the route after the selection returns to Telegram", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    const hub = freshChannels("gated-back");
    await hub.handleTelegramUpdate({ update_id: 1 });

    setEnv({ ACTIVE_CHANNEL: "telegram" });
    await evictDurableObject(hub);
    const events = await captureButler();
    const tg = fakeTelegram(MESSAGE);
    setChannelOverride("telegram", tg.adapter);

    await hub.handleTelegramUpdate({ update_id: 1 });

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
      },
      async edit() {},
      async sendArtifact() {},
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

  it("prefers a button hint over the encoded task id", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    const hub = freshChannels("send-wechat-hint");
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
      },
      async edit() {},
      async sendArtifact() {},
      async answerAction() {},
    });

    await hub.sendCurrent({
      text: "x",
      buttons: [[{ label: "取消", data: "a:cancel:t3", hint: "取消 #1" }]],
    });

    expect(sent).toEqual([
      { to: "u1", msg: { text: 'x\n回复"取消 #1"' } },
    ]);
  });

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

  it("filters unsupported markdown for WeChat without buttons", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    const hub = freshChannels("send-wechat-plain");
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
      text: "*中文* ![图](https://example.com/a.png) 完毕",
    });

    expect(wx.sent).toEqual([{ to: "u1", msg: { text: "中文  完毕" } }]);
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

  it("does not fall back to Telegram when WeChat has no context", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    setWeChatCredentialsOverride(
      JSON.stringify({
        token: "token-a",
        baseUrl: "https://ilinkai.weixin.qq.com",
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

    const outcome = await runInDurableObject(hub, async (instance, state) => {
      await instance.sendCurrent({ text: "x" });
      // Without a context token the send is rejected and held in the queue,
      // and it must not fall through to Telegram.
      return state.storage.sql
        .exec<{ text: string }>(`SELECT text FROM outbound_queue`)
        .toArray();
    });

    expect(outcome).toEqual([{ text: "x" }]);
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
      async sendArtifact() {},
      async answerAction() {},
    });

    await hub.sendCurrent({
      text: "t3 请求执行 web_fetch",
      buttons: [
        [
          { label: "批准", data: "a:approve:t3:ap1" },
          { label: "拒绝", data: "a:reject:t3:ap1" },
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

describe("sendArtifact", () => {
  it("refuses a key that is not an artifact key", async () => {
    setChannelOverride("telegram", fakeTelegram(null).adapter);

    // Assert inside the object: an RPC-level rejection also surfaces as an
    // unhandled rejection, which vitest reports as a run error.
    await runInDurableObject(channels(), async (instance) => {
      await expect(
        instance.sendArtifact("t1/../../etc/passwd"),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  it("refuses a missing artifact", async () => {
    setChannelOverride("telegram", fakeTelegram(null).adapter);

    await runInDurableObject(channels(), async (instance) => {
      await expect(
        instance.sendArtifact("t1/f1/none.md"),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  it("sends the stored bytes through the current adapter", async () => {
    const tg = fakeTelegram(null);
    setChannelOverride("telegram", tg.adapter);
    await env.ARTIFACTS.put("t1/f1/report.md", "# body", {
      httpMetadata: { contentType: "text/markdown" },
    });

    await channels().sendArtifact("t1/f1/report.md");

    expect(tg.artifacts).toEqual([
      { to: String(OWNER_ID), name: "report.md", contentType: "text/markdown" },
    ]);
  });
});

describe("sendArtifact retries and missing prerequisites", () => {
  it("attempts a WeChat 4xx rejection exactly once", async () => {
    setEnv({
      ACTIVE_CHANNEL: "wechat",
      WECHAT_CREDENTIALS: JSON.stringify({
        token: "token-a",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-a",
        userId: "bot-user",
      }),
    });
    const hub = freshChannels("artifact-wechat-4xx");
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES ('wechat', 'wx-owner', ?)`,
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT INTO wechat_contexts (user_id, context_token, updated_at)
         VALUES ('wx-owner', 'ctx-1', ?)`,
        Date.now(),
      );
    });
    await env.ARTIFACTS.put("t1/f1/report.md", "# body");

    let calls = 0;
    setChannelOverride("wechat", {
      parseInbound: async () => null,
      async send() {
        return { messageId: "" };
      },
      async sendArtifact() {
        calls += 1;
        throw new ILinkError("rejected", -2, 403);
      },
      async edit() {},
      async answerAction() {},
    });

    await runInDurableObject(hub, async (instance) => {
      await expect(instance.sendArtifact("t1/f1/report.md")).rejects.toBeInstanceOf(
        ILinkError,
      );
    });
    expect(calls).toBe(1);
  });

  it("refuses to send an artifact when no channel is selected", async () => {
    setEnv({ ACTIVE_CHANNEL: "slack" });
    const hub = freshChannels("artifact-no-channel");
    await env.ARTIFACTS.put("t2/f1/report.md", "# body");

    const outcome = await runInDurableObject(hub, (instance) =>
      instance.sendArtifact("t2/f1/report.md").then(
        () => "sent",
        (error: Error) => error.message,
      ),
    );
    expect(outcome).toBe("channel selection disabled");
  });

  it("refuses to send on WeChat without a stored context token", async () => {
    setEnv({
      ACTIVE_CHANNEL: "wechat",
      WECHAT_CREDENTIALS: JSON.stringify({
        token: "token-a",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "bot-a",
        userId: "bot-user",
      }),
    });
    const hub = freshChannels("artifact-no-context");
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES ('wechat', 'wx-owner', ?)`,
        Date.now(),
      );
    });
    await env.ARTIFACTS.put("t3/f1/report.md", "# body");

    const outcome = await runInDurableObject(hub, (instance) =>
      instance.sendArtifact("t3/f1/report.md").then(
        () => "sent",
        (error: Error & { status?: number }) => `${error.message}/${error.status}`,
      ),
    );
    expect(outcome).toBe("wechat context missing/0");
  });
});
