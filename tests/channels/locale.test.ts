import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  channelDisabledText,
  channelErrorText,
} from "../../src/channels/channel-do";
import { setChannelOverride } from "../../src/channels/override";
import type { ChannelAdapter } from "../../src/channels/types";
import type {
  ActionEvent,
  InboundEvent,
  OutboundMessage,
} from "../../src/protocol";
import { readRuntimeConfig } from "../../src/runtime-config";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const HAN = /\p{Script=Han}/u;
const ENV = env as unknown as Record<string, unknown>;
const OWNER_ID = readRuntimeConfig(
  env as unknown as Env,
).owner.telegramUserIds[0]!;

function englishConfig(): Record<string, unknown> {
  return {
    ...(ENV.DESKWAND_CONFIG as Record<string, unknown>),
    locale: "en",
  };
}

async function seedWechatAddress(name: string) {
  const hub = env.CHANNELS.get(env.CHANNELS.idFromName(name));
  await runInDurableObject(hub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
       VALUES ('wechat', 'u1', ?)`,
      Date.now(),
    );
  });
  return hub;
}

function recordingWechat() {
  const sent: { to: string; msg: OutboundMessage }[] = [];
  const adapter: ChannelAdapter = {
    parseInbound: async () => null,
    async send(to, msg) {
      sent.push({ to, msg });
      return { messageId: "" };
    },
    async edit() {},
    async sendArtifact() {},
    async answerAction() {},
  };
  return { adapter, sent };
}

describe("channel fallback copy", () => {
  it("keeps the Chinese fallback copy", () => {
    expect(channelDisabledText("zh")).toBe("该渠道未启用");
    expect(channelErrorText("zh")).toBe("出错了，稍后再试");
  });

  it("writes the English fallback copy", () => {
    const messages = [channelDisabledText("en"), channelErrorText("en")];
    for (const message of messages) expect(message).not.toMatch(HAN);
    expect(messages[0]).toBe("This channel is not enabled");
    expect(messages[1]).toBe("Something went wrong, try again later");
  });
});

describe("channel sends the owner's language", () => {
  it("downgrades buttons to English hints when the config says en", async () => {
    const savedChannel = ENV.ACTIVE_CHANNEL;
    const savedConfig = ENV.DESKWAND_CONFIG;
    ENV.ACTIVE_CHANNEL = "wechat";
    ENV.DESKWAND_CONFIG = englishConfig();
    const wx = recordingWechat();
    setChannelOverride("wechat", wx.adapter);
    try {
      const hub = await seedWechatAddress("locale-en-hints");
      await hub.sendCurrent({
        text: "🔐 t3 requests to run web_fetch",
        buttons: [
          [
            { label: "✅ Approve", data: "a:approve:t3:ap1" },
            { label: "❌ Reject", data: "a:reject:t3:ap1" },
          ],
        ],
      });

      expect(wx.sent).toHaveLength(1);
      expect(wx.sent[0]?.msg.text).toBe(
        '🔐 t3 requests to run web_fetch\nReply "approve t3 ap1"\nReply "reject t3 ap1"',
      );
      expect(wx.sent[0]?.msg.text).not.toMatch(HAN);
      expect(wx.sent[0]?.msg.buttons).toBeUndefined();
    } finally {
      setChannelOverride("wechat", null);
      ENV.ACTIVE_CHANNEL = savedChannel;
      ENV.DESKWAND_CONFIG = savedConfig;
    }
  });

  it("answers an old channel in English when the config says en", async () => {
    const savedChannel = ENV.ACTIVE_CHANNEL;
    const savedConfig = ENV.DESKWAND_CONFIG;
    ENV.ACTIVE_CHANNEL = "wechat";
    ENV.DESKWAND_CONFIG = englishConfig();

    const answered: { actionId: string; text?: string }[] = [];
    const action: ActionEvent = {
      type: "action",
      channel: "telegram",
      chatId: "42",
      userId: String(OWNER_ID),
      actionId: "cb-1",
      messageId: "9",
      action: "cancel",
      taskId: "t3",
      eventId: "tg:1",
    };
    const adapter: ChannelAdapter = {
      parseInbound: async (): Promise<InboundEvent | null> => action,
      async send() {
        return { messageId: "1" };
      },
      async edit() {},
      async sendArtifact() {},
      async answerAction(actionId, text) {
        answered.push({
          actionId,
          ...(text === undefined ? {} : { text }),
        });
      },
    };
    setChannelOverride("telegram", adapter);
    try {
      const hub = env.CHANNELS.get(
        env.CHANNELS.idFromName("locale-en-disabled"),
      );
      await expect(
        hub.handleTelegramUpdate({ update_id: 1 }),
      ).resolves.toBe("accepted");

      expect(answered).toEqual([
        { actionId: "cb-1", text: "This channel is not enabled" },
      ]);
    } finally {
      setChannelOverride("telegram", null);
      ENV.ACTIVE_CHANNEL = savedChannel;
      ENV.DESKWAND_CONFIG = savedConfig;
    }
  });
});
