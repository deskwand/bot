import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotsRepo } from "../../src/butler/bots-repo";
import { setBotChatStubOverride } from "../../src/butler/butler-do";
import { setClockOverride } from "../../src/butler/notifier";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import type { AdmittedMessage, RouteSnapshot } from "../../src/protocol";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

let route: RouteSnapshot;

beforeEach(async () => {
  await seedOwnerAddress("42");
  route = await channels().currentRoute();
});

afterEach(() => {
  setClockOverride(null);
  setBotChatStubOverride(null);
  setChannelOverride("telegram", null);
  setModelOverride(null);
  vi.restoreAllMocks();
});

function message(text: string, eventId: string): AdmittedMessage {
  return {
    type: "message",
    channel: "telegram",
    chatId: "42",
    userId: "1",
    text,
    eventId,
    routeKey: route.routeKey,
  };
}

async function indexBot(
  stub: ReturnType<typeof butler>,
  id: string,
  name: string,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    new BotsRepo(state.storage.sql).insert({ id, name });
  });
}

type TurnInternals = {
  checkTurn(): Promise<void>;
  turns(): import("../../src/butler/turn-store").TurnStore;
};

describe("ask_bot", () => {
  it("suppresses the butler answer after ask_bot", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "ask_bot",
              args: { id: "ask-b1", text: "刚才那只股票怎么了" },
            },
          ],
        },
        { text: "已转给盯盘" },
      ]),
    );
    const chats: { botId: string; text: string }[] = [];
    setBotChatStubOverride(() => ({
      chat: async (input) => {
        chats.push({ botId: input.botId, text: input.text });
      },
    }));
    const stub = butler("ask-bot-forward");
    await indexBot(stub, "ask-b1", "盯盘");

    await stub.handleMessage(
      message("刚才那只股票怎么了", "ask-bot:forward"),
    );

    expect(chats).toEqual([
      { botId: "ask-b1", text: "刚才那只股票怎么了" },
    ]);
    expect(channel.sent.map((sent) => sent.text)).not.toContain("已转给盯盘");
  });

  it("delivers the butler answer when ask_bot failed", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "ask_bot",
              args: { id: "ask-b2", text: "刚才那只股票怎么了" },
            },
          ],
        },
        { text: "已转给盯盘" },
      ]),
    );
    let chats = 0;
    setBotChatStubOverride(() => ({
      chat: async () => {
        chats += 1;
        throw new Error("bot offline");
      },
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stub = butler("ask-bot-failed");
    await indexBot(stub, "ask-b2", "盯盘");

    await stub.handleMessage(message("刚才那只股票怎么了", "ask-bot:failed"));

    expect(chats).toBe(1);
    expect(channel.sent.at(-1)?.text).toBe("已转给盯盘");
  });

  it("does not drop an older answer because a later turn used ask_bot", async () => {
    let now = Date.now();
    setClockOverride({
      now: () => now,
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    const channel = fakeChannel();
    const send = channel.adapter.send.bind(channel.adapter);
    let failed = false;
    channel.adapter.send = async (chatId, msg) => {
      if (msg.text === "旧的答案" && !failed) {
        failed = true;
        throw new Error("telegram down");
      }
      return send(chatId, msg);
    };
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([
        { text: "旧的答案" },
        {
          toolCalls: [
            {
              name: "ask_bot",
              args: { id: "ask-b3", text: "刚才那只股票怎么了" },
            },
          ],
        },
        { text: "已转给盯盘" },
      ]),
    );
    const chats: string[] = [];
    setBotChatStubOverride(() => ({
      chat: async (input) => {
        chats.push(input.text);
      },
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stub = butler("ask-bot-older");
    await indexBot(stub, "ask-b3", "盯盘");

    // The first answer fails to send and waits for a retry.
    await stub.handleMessage(message("先查一下", "ask-bot:older"));
    // A later turn hands its answer to a bot, which must not silence the
    // older turn's pending answer.
    await stub.handleMessage(
      message("刚才那只股票怎么了", "ask-bot:later"),
    );
    expect(chats).toHaveLength(1);

    // Wait out both the retry delay and the in-flight-send window.
    now += 61_000;
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as TurnInternals).checkTurn();
    });

    expect(channel.sent.map((sent) => sent.text)).toContain("旧的答案");
  });
});
