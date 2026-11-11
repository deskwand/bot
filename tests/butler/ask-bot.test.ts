import type { TranscriptContext } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotsRepo } from "../../src/butler/bots-repo";
import { setBotChatStubOverride } from "../../src/butler/butler-do";
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

/** The text of the most recent tool result in the request context. */
function toolResultText(context: TranscriptContext): string {
  const message = [...context.messages]
    .reverse()
    .find((entry) => entry.role === "toolResult");
  if (message === undefined || message.role !== "toolResult") return "";
  return message.content
    .map((block) => ("text" in block ? block.text : ""))
    .join("");
}

function asks(
  reply: (input: { botId: string; text: string }) => Promise<string>,
): { texts: string[] } {
  const texts: string[] = [];
  setBotChatStubOverride(() => ({
    ask: async (input) => {
      texts.push(input.text);
      return reply(input);
    },
  }));
  return { texts };
}

describe("ask_bot", () => {
  it("returns the bot's answer as the tool result", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let tool = "";
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
        {
          text: "盯盘说价格回落了",
          observe: (context) => {
            tool = toolResultText(context);
          },
        },
      ]),
    );
    const { texts } = asks(async () => "价格回落了");
    const stub = butler("ask-bot-answer");
    await indexBot(stub, "ask-b1", "盯盘");

    await stub.handleMessage(
      message("刚才那只股票怎么了", "ask-bot:answer"),
    );

    expect(texts).toEqual(["刚才那只股票怎么了"]);
    expect(tool).toBe("价格回落了");
  });

  it("sends the butler's final reply after ask_bot", async () => {
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
        { text: "盯着那只股票的机器人说价格回落了" },
      ]),
    );
    asks(async () => "价格回落了");
    const stub = butler("ask-bot-reply");
    await indexBot(stub, "ask-b2", "盯盘");

    await stub.handleMessage(
      message("刚才那只股票怎么了", "ask-bot:reply"),
    );

    expect(channel.sent.map((sent) => sent.text)).toEqual([
      "收到，正在处理",
      "盯着那只股票的机器人说价格回落了",
    ]);
  });

  it("never sends a message straight from the bot", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "ask_bot",
              args: { id: "ask-b3", text: "刚才那只股票怎么了" },
            },
          ],
        },
        { text: "价格回落了，盯盘说的" },
      ]),
    );
    asks(async () => "机器人的原话");
    const stub = butler("ask-bot-direct");
    await indexBot(stub, "ask-b3", "盯盘");

    await stub.handleMessage(
      message("刚才那只股票怎么了", "ask-bot:direct"),
    );

    expect(channel.sent.map((sent) => sent.text)).not.toContain("机器人的原话");
  });

  it("reports a missing bot", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let tool = "";
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "ask_bot",
              args: { id: "ask-b9", text: "刚才那只股票怎么了" },
            },
          ],
        },
        {
          text: "没有这个机器人",
          observe: (context) => {
            tool = toolResultText(context);
          },
        },
      ]),
    );
    const chats = vi.fn();
    setBotChatStubOverride(() => ({ ask: chats }));
    const stub = butler("ask-bot-missing");
    await indexBot(stub, "ask-b1", "盯盘");

    await stub.handleMessage(
      message("刚才那只股票怎么了", "ask-bot:missing"),
    );

    expect(tool).toBe("没有机器人 ask-b9");
    expect(chats).not.toHaveBeenCalled();
    expect(channel.sent.at(-1)?.text).toBe("没有这个机器人");
  });

  it("returns an error result when the bot chat throws", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let tool = "";
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "ask_bot",
              args: { id: "ask-b4", text: "刚才那只股票怎么了" },
            },
          ],
        },
        {
          text: "那个机器人暂时联系不上",
          observe: (context) => {
            tool = toolResultText(context);
          },
        },
      ]),
    );
    setBotChatStubOverride(() => ({
      ask: async () => {
        throw new Error("bot offline");
      },
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stub = butler("ask-bot-throws");
    await indexBot(stub, "ask-b4", "盯盘");

    await stub.handleMessage(
      message("刚才那只股票怎么了", "ask-bot:throws"),
    );

    expect(tool).toBe("bot offline");
    expect(channel.sent.at(-1)?.text).toBe("那个机器人暂时联系不上");
  });
});
