import type { TranscriptContext } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotsRepo } from "../../src/butler/bots-repo";
import { setBotChatStubOverride } from "../../src/butler/butler-do";
import { butlerSystemPrompt } from "../../src/butler/prompt";
import { setChannelOverride } from "../../src/channels/override";
import { t } from "../../src/i18n";
import { setModelOverride } from "../../src/llm/models";
import type { AdmittedMessage, RouteSnapshot } from "../../src/protocol";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const DAY_MS = 86_400_000;

/** 真实的 8×8 纯色 PNG。 */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mM4YWODFTEMLQkAZZlQAS/gME0AAAAASUVORK5CYII=";

let route: RouteSnapshot;

let modelCalls = 0;

let imageRequest: TranscriptContext | undefined;

/**
 * Every model is built at module load, so every scripted provider is in the
 * catalog before the first harness opens. The Butler is a single "owner"
 * object across this file; a provider registered later would be unknown to
 * the catalog its session opened with, and a model switch would fail.
 */
const MODELS = {
  botAnswer: scriptedModel([{ text: "价格回落了" }]),
  quoteAnswer: scriptedModel([{ text: "明天见" }]),
  emptyCheck: scriptedModel([
    {
      text: "不应出现",
      observe: () => {
        modelCalls += 1;
      },
    },
    {
      text: "不应出现",
      observe: () => {
        modelCalls += 1;
      },
    },
  ]),
  ambiguousCheck: scriptedModel([
    {
      text: "不应出现",
      observe: () => {
        modelCalls += 1;
      },
    },
  ]),
  filesAnswer: scriptedModel([{ text: "文件收到了" }]),
  imageAnswer: scriptedModel([
    {
      text: "看到了",
      observe: (context) => {
        imageRequest = context;
      },
    },
  ]),
  plainAnswer: scriptedModel([{ text: "普通回答" }]),
  nameAnswer: scriptedModel([{ text: "命名回答" }]),
};

function butler() {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

function botStub(id: string) {
  return env.BOT.get(env.BOT.idFromName(id));
}

function message(evt: {
  text: string | null;
  eventId: string;
  images?: AdmittedMessage["images"];
  files?: AdmittedMessage["files"];
  quotedText?: string;
}): AdmittedMessage {
  return {
    type: "message",
    channel: "telegram",
    chatId: "42",
    userId: "1",
    text: evt.text,
    ...(evt.images === undefined ? {} : { images: evt.images }),
    ...(evt.files === undefined ? {} : { files: evt.files }),
    ...(evt.quotedText === undefined ? {} : { quotedText: evt.quotedText }),
    eventId: evt.eventId,
    routeKey: route.routeKey,
  };
}

/** Adds a bot to the Butler's index, as `create_bot` would. */
async function indexBot(id: string, name: string): Promise<void> {
  await runInDurableObject(butler(), (_instance, state) => {
    new BotsRepo(state.storage.sql).insert({ id, name });
  });
}

/** The Butler index row plus the real BotDO behind it. */
async function seedBot(id: string, name: string): Promise<void> {
  await indexBot(id, name);
  await botStub(id).init({
    botId: id,
    name,
    mission: "盯着价格",
    defaultIntervalMs: DAY_MS,
    firstWakeAt: Date.UTC(2030, 0, 1),
  });
}

beforeEach(async () => {
  modelCalls = 0;
  imageRequest = undefined;
  await seedOwnerAddress("42");
  route = await channels().currentRoute();
});

afterEach(() => {
  setBotChatStubOverride(null);
  setModelOverride(null);
  setChannelOverride("telegram", null);
  vi.restoreAllMocks();
});

describe("bot chat routing", () => {
  it("@name goes to the bot and stays out of the butler transcript", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(MODELS.botAnswer);
    await seedBot("route-b1", "路由甲");

    const stub = butler();
    await stub.handleMessage(
      message({ text: "@路由甲 最近怎样了", eventId: "tg:route-1" }),
    );

    expect(channel.sent).toEqual([
      { chatId: "42", text: "🤖 路由甲：价格回落了" },
    ]);
    const messages = await runInDurableObject(stub, (instance) =>
      instance.harness.session().messages(),
    );
    expect(JSON.stringify(messages)).not.toContain("最近怎样了");
  });

  it("a quoted bot message goes to that bot", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(MODELS.quoteAnswer);
    await seedBot("route-b2", "路由乙");

    await butler().handleMessage(
      message({
        text: "那明天再看",
        quotedText: "🤖 路由乙：价格回落了",
        eventId: "tg:route-2",
      }),
    );

    expect(channel.sent).toEqual([
      { chatId: "42", text: "🤖 路由乙：明天见" },
    ]);
  });

  it("an address without text asks what to say and calls no model", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(MODELS.emptyCheck);
    await indexBot("route-b3", "路由丙");

    await butler().handleMessage(
      message({ text: "@路由丙", eventId: "tg:route-3" }),
    );

    expect(channel.sent).toEqual([
      {
        chatId: "42",
        text: t("zh", "butler.botChat.empty", { name: "路由丙" }),
      },
    ]);
    expect(modelCalls).toBe(0);
  });

  it("a duplicated name asks for the id and lists the matches", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(MODELS.ambiguousCheck);
    await indexBot("route-b4", "重名路由");
    await indexBot("route-b5", "重名路由");

    await butler().handleMessage(
      message({ text: "@重名路由 hi", eventId: "tg:route-4" }),
    );

    expect(channel.sent).toEqual([
      {
        chatId: "42",
        text: t("zh", "butler.botChat.ambiguous", {
          name: "重名路由",
          lines: "route-b4 重名路由\nroute-b5 重名路由",
        }),
      },
    ]);
    expect(modelCalls).toBe(0);
  });

  it("a chat failure answers unavailable and never the butler model", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(MODELS.emptyCheck);
    await indexBot("route-b6", "路由丁");
    setBotChatStubOverride(() => ({
      chat: async () => {
        throw new Error("chat exploded");
      },
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await butler().handleMessage(
      message({ text: "@路由丁 你好", eventId: "tg:route-5" }),
    );

    expect(channel.sent).toEqual([
      {
        chatId: "42",
        text: t("zh", "butler.botChat.unavailable", { name: "路由丁" }),
      },
    ]);
    expect(modelCalls).toBe(0);
  });

  it("a message with files stays with the butler", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(MODELS.filesAnswer);
    await seedBot("route-b7", "路由戊");

    await butler().handleMessage(
      message({
        text: "@路由戊 看看这个",
        files: [
          {
            name: "a.pdf",
            key: "inbox/tg:route-6/a.pdf",
            mimeType: "application/pdf",
            size: 2048,
          },
        ],
        eventId: "tg:route-6",
      }),
    );

    expect(channel.sent).toEqual([{ chatId: "42", text: "文件收到了" }]);
  });

  it("an image is forwarded to the bot chat", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(MODELS.imageAnswer);
    await seedBot("route-b8", "路由己");

    await butler().handleMessage(
      message({
        text: "@路由己 这是什么",
        images: [{ mimeType: "image/png", data: PNG_B64 }],
        eventId: "tg:route-7",
      }),
    );

    const last = imageRequest?.messages
      .filter((entry) => entry.role === "user")
      .at(-1);
    expect(last?.content).toEqual([
      { type: "text", text: "这是什么" },
      { type: "image", data: PNG_B64, mimeType: "image/png" },
    ]);
    expect(channel.sent).toEqual([
      { chatId: "42", text: "🤖 路由己：看到了" },
    ]);
  });

  it("a plain message stays with the butler", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(MODELS.plainAnswer);

    await butler().handleMessage(
      message({ text: "随便问问", eventId: "tg:route-8" }),
    );

    expect(channel.sent).toEqual([{ chatId: "42", text: "普通回答" }]);
  });

  it("names each bot chat after the bot id and its creation time", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(MODELS.nameAnswer);
    await seedBot("route-b9", "路由庚");
    const createdAt = await runInDurableObject(butler(), (_instance, state) =>
      new BotsRepo(state.storage.sql).get("route-b9")!.createdAt,
    );

    await butler().handleMessage(
      message({ text: "@路由庚 你好", eventId: "tg:route-9" }),
    );

    expect(channel.sent).toEqual([
      { chatId: "42", text: "🤖 路由庚：命名回答" },
    ]);
    const named = env.BOT_CHAT.get(
      env.BOT_CHAT.idFromName(`route-b9@${createdAt}`),
    );
    const stored = await runInDurableObject(named, (_instance, state) =>
      state.storage.kv.get("botId"),
    );
    expect(stored).toBe("route-b9");
  });
});

describe("butler prompt bot chat line", () => {
  it("tells the owner how to reach a bot directly", () => {
    const prompt = butlerSystemPrompt("zh", [], "telegram");
    expect(prompt).toContain("@名字");
    expect(prompt).toContain("直接回复机器人消息");
  });
});
