import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
  type FauxResponseStep,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PiHarness, PiSession, type PiModel } from "agents/harness/pi";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotsRepo } from "../../src/butler/bots-repo";
import { setBotChatStubOverride } from "../../src/butler/butler-do";
import { setChannelOverride } from "../../src/channels/override";
import {
  PAID_PLAN_REQUIRED_TEXT,
  QUOTA_EXHAUSTED_TEXT,
  WORKERS_AI_PAID_PLAN_MARKER,
  WORKERS_AI_QUOTA_MARKER,
} from "../../src/llm/model-errors";
import { registerTestProvider, setModelOverride } from "../../src/llm/models";
import type { SpendEntry } from "../../src/life/books";
import { lifeStub } from "../../src/life/client";
import { lifeBlock } from "../../src/life/prompt";
import { PI_PROGRESS } from "../../src/llm/pi-settings";
import { phoneRules } from "../../src/phone/style";
import type { AdmittedMessage, OutboundMessage, RouteSnapshot } from "../../src/protocol";
import { t } from "../../src/i18n";
import { fakeChannel } from "../helpers/fake-channel";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { resetLife } from "../helpers/life";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const SlowWait = Type.Object({});

type SlowControl = { started: boolean; released: boolean };

type Turn = {
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
  observe?: (context: TranscriptContext) => void;
};

/**
 * A fresh Butler per test. `ButlerDO` opens pi with the model catalog as it is
 * when the object starts, so each test needs an object that starts after its
 * scripted provider was registered.
 */
function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function task(taskId: string) {
  return env.TASK.get(env.TASK.idFromName(taskId));
}

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

let route: RouteSnapshot;

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();
/** The receipt every accepted message earns before its answer. */
const RECEIPT = { chatId: "42", text: "收到，正在处理" };

/** Mutates the env seen by Durable Objects created after this call. */
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

/** A readable configuration whose butler role carries `thinkingLevel`. */
function configureButler(
  thinkingLevel?: string,
  modelId = "deepseek-v4.1-flash",
): void {
  setEnv({
    DESKWAND_CONFIG: {
      schemaVersion: 1,
      owner: { telegramUserIds: [100000001] },
      models: {
        butler: {
          provider: "opencode-go",
          id: modelId,
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        },
        task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
      },
      mcpServers: [],
    },
  });
}

async function storedThinkingLevel(stub: ReturnType<typeof butler>): Promise<string> {
  return runInDurableObject(stub, async (instance) => {
    const harness = (instance as unknown as { harness: PiHarness }).harness;
    const conversation = await (await harness.pi()).root(BACKGROUND_CONTEXT);
    return (await conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel;
  });
}

function message(evt: {
  text: string | null;
  eventId: string;
  channel?: AdmittedMessage["channel"];
  chatId?: string;
  images?: AdmittedMessage["images"];
  files?: AdmittedMessage["files"];
  quotedText?: string;
  fileFailed?: AdmittedMessage["fileFailed"];
  imageFailed?: boolean;
  voiceFailed?: boolean;
}): AdmittedMessage {
  return {
    type: "message",
    channel: evt.channel ?? "telegram",
    chatId: evt.chatId ?? "42",
    userId: "1",
    text: evt.text,
    ...(evt.images === undefined ? {} : { images: evt.images }),
    ...(evt.files === undefined ? {} : { files: evt.files }),
    ...(evt.quotedText === undefined ? {} : { quotedText: evt.quotedText }),
    ...(evt.fileFailed === undefined ? {} : { fileFailed: evt.fileFailed }),
    ...(evt.imageFailed === undefined ? {} : { imageFailed: evt.imageFailed }),
    ...(evt.voiceFailed === undefined ? {} : { voiceFailed: evt.voiceFailed }),
    eventId: evt.eventId,
    routeKey: route.routeKey,
  };
}

/** 真实的 8×8 纯色 PNG。 */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mM4YWODFTEMLQkAZZlQAS/gME0AAAAASUVORK5CYII=";

/**
 * One scripted provider for both roles. The Butler and the Task DO normally
 * resolve different configured models, but tests run against a single model
 * override, so requests are told apart by the system prompt.
 */
function routedModel(butlerTurns: Turn[], taskTurns: Turn[]): PiModel {
  const id = "routed";
  const faux = fauxProvider({ provider: id, api: id, models: [{ id }] });
  const queues: Record<"butler" | "task", Turn[]> = {
    butler: [...butlerTurns],
    task: [...taskTurns],
  };

  const next = (context: TranscriptContext): FauxResponseStep => {
    const role = isTaskRequest(context) ? "task" : "butler";
    const turn = queues[role].shift() ?? { text: "done" };
    turn.observe?.(context);
    return fauxAssistantMessage(
      [
        ...(turn.text === undefined ? [] : [fauxText(turn.text)]),
        ...(turn.toolCalls ?? []).map((call) =>
          fauxToolCall(call.name, call.args as ToolCall["arguments"]),
        ),
      ],
      { stopReason: turn.toolCalls?.length ? "toolUse" : "stop" },
    );
  };

  const provider: Provider = {
    ...faux.provider,
    stream: (model, context, options) => {
      faux.setResponses([next(context)]);
      return faux.provider.stream(model, context, options);
    },
    streamSimple: (model, context, options) => {
      faux.setResponses([next(context)]);
      return faux.provider.streamSimple(model, context, options);
    },
  };

  registerTestProvider(provider);
  return { provider: id, id };
}

/** The last user message the model saw, as plain text. */
function userText(context: TranscriptContext | undefined): string {
  const last = context?.messages
    .filter((entry) => entry.role === "user")
    .at(-1);
  if (last === undefined || last.role !== "user") return "";
  if (typeof last.content === "string") return last.content;
  return last.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

/**
 * The rendered system prompt lives in a system entry's `sections` map, not in
 * its `content` (which pi keeps empty for section-carrying entries).
 */
function isTaskRequest(context: TranscriptContext): boolean {
  return context.messages.some((entry) => {
    if (entry.role !== "system") return false;
    const sections = (entry as { sections?: unknown }).sections;
    return JSON.stringify(sections).includes("background worker for task");
  });
}

/** Flattens the replayed system sections into the prompt the model sees. */
function systemPromptText(context: TranscriptContext | undefined): string {
  const shown = new Map<string, string>();
  for (const entry of context?.messages ?? []) {
    if (entry.role !== "system") continue;
    const sections = (entry as { sections?: Record<string, string | null> })
      .sections;
    if (sections === undefined) continue;
    for (const [key, value] of Object.entries(sections)) {
      if (value === null) shown.delete(key);
      else shown.set(key, value);
    }
  }
  return [...shown.values()].join("\n\n");
}

/** A tool that keeps the task running until the test releases it. */
async function installSlowWait(stub: ReturnType<typeof task>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const control: SlowControl = { started: false, released: false };
    (instance as { slowControl?: SlowControl }).slowControl = control;

    const tool: ToolRegistration<typeof SlowWait> = {
      name: "slow_wait",
      description: "Wait until the test releases the run.",
      parameters: SlowWait,
      async execute() {
        control.started = true;
        while (!control.released) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return { output: [{ type: "text", text: "released" }] };
      },
    };
    instance.registry.install({ name: "test-slow", tools: [tool] });
  });
}

async function releaseSlowTask(stub: ReturnType<typeof task>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const control = (instance as { slowControl?: SlowControl }).slowControl;
    if (control) control.released = true;
  });
}

beforeEach(async () => {
  await seedOwnerAddress("42");
  route = await channels().currentRoute();
});

afterEach(() => {
  setModelOverride(null);
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  setBotChatStubOverride(null);
  vi.restoreAllMocks();
  restoreEnv();
});

describe("butler chat", () => {
  for (const reopen of [false, true]) {
    it(`rejects a smaller model without changing history${reopen ? " after reopening Pi" : ""}`, async () => {
      const channel = fakeChannel();
      setChannelOverride("telegram", channel.adapter);
      let targetRequests = 0;
      const large = scriptedModel([{ text: "original answer" }], { contextWindow: 128000 });
      const small = scriptedModel([{ text: "unsafe target", observe: () => { targetRequests += 1; } }], { contextWindow: 16000 });
      setModelOverride(large);
      const stub = butler(`window-downgrade-${reopen}`);
      await stub.handleMessage(message({ text: "keep this original detail", eventId: `window:first:${reopen}` }));
      const before = await runInDurableObject(stub, async (instance) => {
        const harness = (instance as unknown as { harness: PiHarness }).harness;
        const conversation = await (await harness.pi()).root(BACKGROUND_CONTEXT);
        const snapshot = {
          entries: await harness.session().messages(),
          model: (await conversation.agent(BACKGROUND_CONTEXT)).model,
          head: (await conversation.context(BACKGROUND_CONTEXT)).head?.id,
        };
        if (reopen) await harness.dispose();
        return snapshot;
      });
      setModelOverride(small);
      for (const attempt of [1, 2]) {
        await stub.handleMessage(message({ text: "next message", eventId: `window:second:${reopen}:${attempt}` }));
        expect(targetRequests).toBe(0);
        expect(channel.sent.at(-1)?.text).toContain("128000");
        expect(channel.sent.at(-1)?.text).toContain("16000");
        const after = await runInDurableObject(stub, async (instance) => {
          const harness = (instance as unknown as { harness: PiHarness }).harness;
          const conversation = await (await harness.pi()).root(BACKGROUND_CONTEXT);
          return {
            entries: await harness.session().messages(),
            model: (await conversation.agent(BACKGROUND_CONTEXT)).model,
            head: (await conversation.context(BACKGROUND_CONTEXT)).head?.id,
          };
        });
        expect(after).toEqual(before);
      }
    });
  }

  it.each([272000, 400000])("allows a 1M to %s GPT-sized switch", async (contextWindow) => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const deepseek = scriptedModel([{ text: "million window" }], { contextWindow: 1_000_000 });
    const gpt = scriptedModel([{ text: "GPT-sized window" }], { contextWindow });
    const smaller = scriptedModel([{ text: "smaller after GPT" }], { contextWindow: 128000 });
    setModelOverride(deepseek);
    const stub = butler(`moderate-shrink-${contextWindow}`);
    await stub.handleMessage(message({ text: "first", eventId: `moderate:first:${contextWindow}` }));
    setModelOverride(gpt);
    await stub.handleMessage(message({ text: "second", eventId: `moderate:second:${contextWindow}` }));
    expect(channel.sent.at(-1)?.text).toBe("GPT-sized window");
    // A subsequent switch uses the current GPT window, not the old 1M window.
    setModelOverride(smaller);
    await stub.handleMessage(message({ text: "third", eventId: `moderate:third:${contextWindow}` }));
    expect(channel.sent.at(-1)?.text).toBe("smaller after GPT");
  });

  it("allows a larger model for the existing conversation", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const small = scriptedModel([{ text: "small answer" }], { contextWindow: 32000 });
    const large = scriptedModel([{ text: "large answer" }], { contextWindow: 128000 });
    setModelOverride(small);
    const stub = butler("window-upgrade");
    await stub.handleMessage(message({ text: "first", eventId: "window:small" }));
    setModelOverride(large);
    await stub.handleMessage(message({ text: "second", eventId: "window:large" }));
    expect(channel.sent.at(-1)?.text).toBe("large answer");
  });

  it("answers a text message", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ text: "你好！" }]));

    await butler("chat-101").handleMessage(
      message({ text: "你好", eventId: "tg:101" }),
    );

    expect(channel.sent).toEqual([
      RECEIPT,
      { chatId: "42", text: "你好！" },
    ]);
  });

  it("reports a turn's model call to the life ledger", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ text: "你好！" }]));
    await resetLife();

    try {
      // Sources are only visible once the metabolism has started.
      await lifeStub(env).recordCredit(20, "");
      await butler("chat-ledger").handleMessage(
        message({ text: "你好", eventId: "tg:ledger" }),
      );

      await vi.waitFor(async () => {
        const vitals = await lifeStub(env).vitals();
        expect(vitals.topSources.map((entry) => entry.source)).toContain(
          "butler",
        );
      });
    } finally {
      await resetLife();
    }
  });

  it("records a credit the owner reports to the books", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "life_credit", args: { usd: 20 } }] },
        { text: "记下了" },
      ]),
    );

    await resetLife();
    try {
      await butler("chat-life-credit").handleMessage(
        message({ text: "给你充了 20 美元", eventId: "tg:life-credit" }),
      );

      const vitals = await lifeStub(env).vitals();
      expect(vitals).toMatchObject({
        balanceUsd: 20,
        metabolismStarted: true,
      });
    } finally {
      await resetLife();
    }
  });

  it("puts the vitals after the phone rules and omits them before metabolism starts", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    await resetLife();
    try {
      await lifeStub(env).recordCredit(20, "");
      const spend: SpendEntry = {
        callId: "life-prompt-spend",
        at: Date.now(),
        source: "butler",
        provider: "test",
        model: "test",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        usd: 2,
        priced: true,
      };
      await lifeStub(env).recordSpend(spend);
      const block = lifeBlock("zh", await lifeStub(env).vitals());

      let seen: TranscriptContext | undefined;
      setModelOverride(
        scriptedModel([
          {
            text: "活着",
            observe: (context) => {
              seen = context;
            },
          },
        ]),
      );
      await butler("chat-life-prompt").handleMessage(
        message({ text: "你好", eventId: "tg:life-prompt" }),
      );

      const prompt = systemPromptText(seen);
      const phone = phoneRules("zh", { conversational: true });
      expect(prompt.endsWith(block)).toBe(true);
      expect(prompt.indexOf(phone)).toBeGreaterThan(-1);
      expect(prompt.indexOf(phone)).toBeLessThan(prompt.indexOf(block));

      await resetLife();
      let clean: TranscriptContext | undefined;
      setModelOverride(
        scriptedModel([
          {
            text: "好",
            observe: (context) => {
              clean = context;
            },
          },
        ]),
      );
      await butler("chat-life-prompt-clean").handleMessage(
        message({ text: "你好", eventId: "tg:life-prompt-clean" }),
      );

      expect(systemPromptText(clean)).not.toContain(
        "活下去是你的第一要务",
      );
    } finally {
      await resetLife();
    }
  });

  it("sends an @mention to the butler conversation", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        {
          text: "盯盘那边说价格回落了。",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );
    const ask = vi.fn(async () => "机器人的回答");
    setBotChatStubOverride(() => ({ ask }));
    const stub = butler("chat-addressed");
    await runInDurableObject(stub, (_instance, state) => {
      new BotsRepo(state.storage.sql).insert({ id: "chat-b1", name: "盯盘" });
    });

    await stub.handleMessage(
      message({ text: "@盯盘 现在什么情况", eventId: "tg:addressed" }),
    );

    expect(userText(seen)).toBe("@盯盘 现在什么情况");
    expect(ask).not.toHaveBeenCalled();
    expect(channel.sent.map((sent) => sent.text)).toEqual([
      RECEIPT.text,
      "盯盘那边说价格回落了。",
    ]);
  });

  it("adds no quote line when nothing is quoted", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        {
          text: "好",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );

    await butler("chat-no-quote").handleMessage(
      message({ text: "随便问问", eventId: "tg:no-quote" }),
    );

    expect(userText(seen)).toBe("随便问问");
    expect(userText(seen)).not.toContain("主人引用了这条消息");
    expect(channel.sent.at(-1)?.text).toBe("好");
  });

  it("puts the ledger prefix, quote line and message in order", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        {
          text: "好",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );
    const stub = butler("chat-quote-order");
    await runInDurableObject(stub, (instance) => {
      instance.ledger.add("bot.message", "chat-b1", "价格回落了", Date.now());
    });
    const quoted = `今天的情况是这样的：${"引".repeat(5000)}`;
    const original = "那明天再看看";

    await stub.handleMessage(
      message({
        text: original,
        quotedText: quoted,
        eventId: "tg:quote-order",
      }),
    );

    const text = userText(seen);
    const header = t("zh", "phone.ledgerHeader");
    const quoteLine = t("zh", "butler.quoted", {
      snippet: `今天的情况是这样的：${"引".repeat(100 - [..."今天的情况是这样的："].length)}…`,
    });
    expect(text).toContain(`${quoteLine}\n${original}`);
    expect(text.startsWith(header)).toBe(true);
    expect(text.indexOf(header)).toBeLessThan(text.indexOf(quoteLine));
    expect(text.indexOf(quoteLine)).toBeLessThan(text.indexOf(original));
    expect(channel.sent.at(-1)?.text).toBe("好");
  });

  it("opens the pi harness with the slow progress policy", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ text: "你好！" }]));
    const open = vi.spyOn(Harness, "open");

    await butler("chat-progress").handleMessage(
      message({ text: "你好", eventId: "tg:progress" }),
    );

    expect(open).toHaveBeenCalled();
    for (const call of open.mock.calls) {
      expect(call[1].settings).toEqual({
        progress: PI_PROGRESS,
        followUpMode: "all",
        afterFailedRun: "continue",
      });
    }
    expect(PI_PROGRESS).toEqual({
      partialIntervalMs: 30_000,
      outputIntervalMs: 30_000,
    });
  });

  it("explains an exhausted Workers AI allowance", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ error: WORKERS_AI_QUOTA_MARKER }]));

    await butler("chat-quota").handleMessage(
      message({ text: "你好", eventId: "tg:quota" }),
    );

    expect(channel.sent).toEqual([
      RECEIPT,
      { chatId: "42", text: QUOTA_EXHAUSTED_TEXT },
    ]);
  });

  it("explains a paid-plan-only model", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ error: WORKERS_AI_PAID_PLAN_MARKER }]));

    await butler("chat-paid-plan").handleMessage(
      message({ text: "你好", eventId: "tg:paid-plan" }),
    );

    expect(channel.sent).toEqual([
      RECEIPT,
      { chatId: "42", text: PAID_PLAN_REQUIRED_TEXT },
    ]);
  });

  it("keeps the generic error for other model failures", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ error: "upstream exploded" }]));

    await butler("chat-model-error").handleMessage(
      message({ text: "你好", eventId: "tg:model-error" }),
    );

    expect(channel.sent).toEqual([
      RECEIPT,
      { chatId: "42", text: "出错了，稍后再试" },
    ]);
  });

  it("keeps the fallback reply when the transcript cannot be read", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ error: WORKERS_AI_QUOTA_MARKER }]));
    vi.spyOn(PiSession.prototype, "messages").mockRejectedValue(
      new Error("transcript unavailable"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await butler("chat-transcript-unreadable").handleMessage(
      message({ text: "你好", eventId: "tg:transcript-unreadable" }),
    );

    expect(channel.sent).toEqual([
      RECEIPT,
      { chatId: "42", text: "出错了，稍后再试" },
    ]);
  });

  it("applies the butler role's thinking level to the conversation", async () => {
    configureButler("high");
    setChannelOverride("telegram", fakeChannel().adapter);
    setModelOverride(scriptedModel([{ text: "好" }]));
    const stub = butler("thinking-level");
    await stub.handleMessage(message({ text: "你好", eventId: "tg:thinking" }));
    expect(await storedThinkingLevel(stub)).toBe("high");
  });

  it("falls back to the model's middle level when the role omits it", async () => {
    configureButler();
    setChannelOverride("telegram", fakeChannel().adapter);
    setModelOverride(scriptedModel([{ text: "好" }]));
    const stub = butler("thinking-default");
    await stub.handleMessage(message({ text: "你好", eventId: "tg:thinking-default" }));
    // opencode-go/deepseek-v4.1-flash offers low, high, max.
    expect(await storedThinkingLevel(stub)).toBe("high");
  });

  it("keeps an explicit off instead of the middle", async () => {
    configureButler("off", "deepseek-v4-pro");
    setChannelOverride("telegram", fakeChannel().adapter);
    setModelOverride(scriptedModel([{ text: "好" }]));
    const stub = butler("thinking-explicit-off");
    await stub.handleMessage(message({ text: "你好", eventId: "tg:thinking-off" }));
    expect(await storedThinkingLevel(stub)).toBe("off");
  });

  it("applies an explicit off to an existing conversation", async () => {
    configureButler("high", "deepseek-v4-pro");
    setChannelOverride("telegram", fakeChannel().adapter);
    setModelOverride(scriptedModel([{ text: "好" }, { text: "好" }]));
    const stub = butler("thinking-off-existing");
    await stub.handleMessage(message({ text: "你好", eventId: "tg:off:first" }));
    expect(await storedThinkingLevel(stub)).toBe("high");

    // A downgrade is the one case where "already off" and "configured to off"
    // would otherwise look the same.
    configureButler("off", "deepseek-v4-pro");
    await stub.handleMessage(message({ text: "再来", eventId: "tg:off:second" }));
    expect(await storedThinkingLevel(stub)).toBe("off");
  });

  it("falls back to the middle after the level is removed from the config", async () => {
    configureButler("low");
    setChannelOverride("telegram", fakeChannel().adapter);
    setModelOverride(scriptedModel([{ text: "好" }, { text: "好" }]));
    const stub = butler("thinking-removed");
    await stub.handleMessage(message({ text: "你好", eventId: "tg:removed:first" }));
    expect(await storedThinkingLevel(stub)).toBe("low");

    configureButler();
    await stub.handleMessage(message({ text: "再来", eventId: "tg:removed:second" }));
    expect(await storedThinkingLevel(stub)).toBe("high");
  });

  it("applies a level published after the conversation already exists", async () => {
    configureButler("low");
    setChannelOverride("telegram", fakeChannel().adapter);
    setModelOverride(scriptedModel([{ text: "好" }, { text: "好" }]));
    const stub = butler("thinking-reopen");
    await stub.handleMessage(message({ text: "你好", eventId: "tg:reopen:first" }));
    expect(await storedThinkingLevel(stub)).toBe("low");

    // Defaults never reach a root that already exists, so the change has to be
    // applied to the conversation itself on the next message.
    configureButler("high");
    await stub.handleMessage(message({ text: "再来", eventId: "tg:reopen:second" }));
    expect(await storedThinkingLevel(stub)).toBe("high");
  });

  it("tells the owner which model key is missing before submitting", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setEnv({
      DESKWAND_CONFIG: {
        schemaVersion: 1,
        owner: { telegramUserIds: [100000001] },
        models: {
          butler: { provider: "deepseek", id: "deepseek-flash" },
          task: { provider: "deepseek", id: "deepseek-flash" },
        },
        mcpServers: [],
      },
      MODEL_KEY_DEEPSEEK: undefined,
    });
    const submit = vi.spyOn(PiHarness.prototype, "submit");

    await butler("chat-missing-key").handleMessage(
      message({ text: "你好", eventId: "tg:109" }),
    );

    expect(channel.sent).toEqual([
      {
        chatId: "42",
        text: "模型 deepseek 没有配置 key（MODEL_KEY_DEEPSEEK），请在桌面端模型页填写",
      },
    ]);
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not answer a redelivered event twice", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ text: "只回一次" }]));

    const evt = message({ text: "你好", eventId: "tg:102" });
    await butler("chat-102").handleMessage(evt);
    await butler("chat-102").handleMessage(evt);

    expect(channel.sent).toEqual([
      RECEIPT,
      { chatId: "42", text: "只回一次" },
    ]);
  });

  it("rejects non-text messages without calling the model", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let calls = 0;
    setModelOverride(
      scriptedModel([
        {
          text: "不应出现",
          observe: () => {
            calls += 1;
          },
        },
      ]),
    );

    await butler("chat-103").handleMessage(
      message({ text: null, eventId: "tg:103" }),
    );

    expect(channel.sent).toEqual([
      { chatId: "42", text: "目前只支持文字、图片和语音消息" },
    ]);
    expect(calls).toBe(0);
  });

  it("submits text and image together", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        {
          text: "看到了",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );

    await butler("chat-110").handleMessage(
      message({
        text: "图里写了什么？",
        eventId: "tg:110",
        images: [{ mimeType: "image/png", data: PNG_B64 }],
      }),
    );

    const last = seen?.messages.filter((entry) => entry.role === "user").at(-1);
    expect(last?.content).toEqual([
      { type: "text", text: "图里写了什么？" },
      { type: "image", data: PNG_B64, mimeType: "image/png" },
    ]);
    expect(channel.sent).toEqual([
      RECEIPT,
      { chatId: "42", text: "看到了" },
    ]);
  });

  it("lists an image's inbox key next to the image", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        {
          text: "看到了",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );

    await butler("chat-112").handleMessage(
      message({
        text: "图里写了什么？",
        eventId: "tg:112",
        images: [{ mimeType: "image/png", data: PNG_B64 }],
        files: [
          {
            name: "scan.png",
            key: "inbox/tg:112/scan.png",
            mimeType: "image/png",
            size: 2048,
          },
        ],
      }),
    );

    const last = seen?.messages.filter((entry) => entry.role === "user").at(-1);
    expect(last?.content).toEqual([
      {
        type: "text",
        text: "图里写了什么？\n[附件] scan.png · image/png · 2.0 KB · key: inbox/tg:112/scan.png",
      },
      { type: "image", data: PNG_B64, mimeType: "image/png" },
    ]);
    expect(channel.sent).toEqual([
      RECEIPT,
      { chatId: "42", text: "看到了" },
    ]);
  });

  it("accepts a message that only carries a file", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        {
          text: "收到文件",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );

    await butler("chat-file-only").handleMessage(
      message({
        text: null,
        eventId: "tg:file-only",
        files: [
          {
            name: "a.pdf",
            key: "inbox/tg:1/a.pdf",
            mimeType: "application/pdf",
            size: 2048,
          },
        ],
      }),
    );

    const last = seen?.messages.filter((entry) => entry.role === "user").at(-1);
    expect(last?.content).toBe(
      "[附件] a.pdf · application/pdf · 2.0 KB · key: inbox/tg:1/a.pdf",
    );
    expect(channel.sent).toEqual([
      RECEIPT,
      { chatId: "42", text: "收到文件" },
    ]);
  });

  it("still hands a file to the model when the image could not be prepared", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        {
          text: "收到附件",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );

    await butler("chat-file-image-failed").handleMessage(
      message({
        text: null,
        eventId: "tg:file-image-failed",
        imageFailed: true,
        files: [
          {
            name: "a.pdf",
            key: "inbox/tg:1/a.pdf",
            mimeType: "application/pdf",
            size: 2048,
          },
        ],
      }),
    );

    const last = seen?.messages.filter((entry) => entry.role === "user").at(-1);
    expect(last?.content).toBe(
      "[附件] a.pdf · application/pdf · 2.0 KB · key: inbox/tg:1/a.pdf",
    );
    expect(channel.sent).toEqual([
      RECEIPT,
      { chatId: "42", text: "收到附件" },
    ]);
  });

  it("appends attachment lines after the text", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        {
          text: "好的",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );

    await butler("chat-file-with-text").handleMessage(
      message({
        text: "总结一下",
        eventId: "tg:file-with-text",
        files: [
          {
            name: "a.pdf",
            key: "inbox/tg:1/a.pdf",
            mimeType: "application/pdf",
            size: 2048,
          },
        ],
      }),
    );

    const last = seen?.messages.filter((entry) => entry.role === "user").at(-1);
    expect(last?.content).toBe(
      "总结一下\n[附件] a.pdf · application/pdf · 2.0 KB · key: inbox/tg:1/a.pdf",
    );
    expect(channel.sent).toEqual([RECEIPT, { chatId: "42", text: "好的" }]);
  });

  it("tells the owner a file was too large", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let calls = 0;
    setModelOverride(
      scriptedModel([
        {
          text: "不应出现",
          observe: () => {
            calls += 1;
          },
        },
      ]),
    );

    await butler("chat-file-too-large").handleMessage(
      message({
        text: null,
        eventId: "tg:file-too-large",
        fileFailed: "too_large",
        imageFailed: true,
      }),
    );

    expect(channel.sent).toEqual([
      { chatId: "42", text: "文件超过 15 MB，没能收下" },
    ]);
    expect(calls).toBe(0);
  });

  it("tells the owner a file could not be received", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let calls = 0;
    setModelOverride(
      scriptedModel([
        {
          text: "不应出现",
          observe: () => {
            calls += 1;
          },
        },
      ]),
    );

    await butler("chat-file-unavailable").handleMessage(
      message({
        text: null,
        eventId: "tg:file-unavailable",
        fileFailed: "download",
      }),
    );

    expect(channel.sent).toEqual([
      {
        chatId: "42",
        text: "收到了文件，但没能取到内容，请稍后再发一次",
      },
    ]);
    expect(calls).toBe(0);
  });

  it("submits an image on its own when there is no text", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        {
          text: "是一张纯色图",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );

    await butler("chat-111").handleMessage(
      message({
        text: null,
        eventId: "tg:111",
        images: [{ mimeType: "image/png", data: PNG_B64 }],
      }),
    );

    const last = seen?.messages.filter((entry) => entry.role === "user").at(-1);
    expect(last?.content).toEqual([
      { type: "image", data: PNG_B64, mimeType: "image/png" },
    ]);
    expect(channel.sent).toEqual([
      RECEIPT,
      { chatId: "42", text: "是一张纯色图" },
    ]);
  });

  it("drops an empty text block when the image is the whole message", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        {
          text: "是一张纯色图",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );

    await butler("chat-113").handleMessage(
      message({
        text: "",
        eventId: "tg:113",
        images: [{ mimeType: "image/png", data: PNG_B64 }],
      }),
    );

    const last = seen?.messages.filter((entry) => entry.role === "user").at(-1);
    expect(last?.content).toEqual([
      { type: "image", data: PNG_B64, mimeType: "image/png" },
    ]);
    expect(channel.sent).toEqual([
      RECEIPT,
      { chatId: "42", text: "是一张纯色图" },
    ]);
  });

  it("says so when an image could not be fetched", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let calls = 0;
    setModelOverride(
      scriptedModel([
        {
          text: "不应出现",
          observe: () => {
            calls += 1;
          },
        },
      ]),
    );

    await butler("chat-114").handleMessage({
      ...message({ text: null, eventId: "tg:114" }),
      imageFailed: true,
    });

    expect(channel.sent).toEqual([
      { chatId: "42", text: "收到了图片，但没能取到图片内容，请稍后再发一次" },
    ]);
    expect(calls).toBe(0);
  });

  it("says so when a voice message could not be transcribed", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let calls = 0;
    setModelOverride(
      scriptedModel([
        {
          text: "不应出现",
          observe: () => {
            calls += 1;
          },
        },
      ]),
    );

    await butler("chat-voice-failed").handleMessage({
      ...message({ text: null, eventId: "tg:voice-failed" }),
      voiceFailed: true,
    });

    expect(channel.sent).toEqual([
      {
        chatId: "42",
        text: "收到了语音，但没能转成文字，请再发一次或换成文字",
      },
    ]);
    expect(calls).toBe(0);
  });

  it("answers images with a fixed note when the model cannot see them", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(null);
    setEnv({
      DESKWAND_CONFIG: {
        schemaVersion: 1,
        owner: { telegramUserIds: [1] },
        models: {
          butler: { provider: "my-proxy", id: "gpt-5.6" },
          task: { provider: "my-proxy", id: "gpt-5.6" },
          customProviders: [
            {
              id: "my-proxy",
              api: "openai-completions",
              baseUrl: "https://proxy.example.com/v1",
              models: [{ id: "gpt-5.6" }],
            },
          ],
        },
        mcpServers: [],
      },
      MODEL_KEY_MY_PROXY: "k",
    });

    await butler("chat-112").handleMessage(
      message({
        text: null,
        eventId: "tg:112",
        images: [{ mimeType: "image/png", data: PNG_B64 }],
      }),
    );

    expect(channel.sent).toEqual([
      {
        chatId: "42",
        text: "当前模型不支持图片，请在桌面端模型页换成支持视觉的模型",
      },
    ]);
  });

  it("spawns a task without a progress message", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      routedModel(
        [
          {
            toolCalls: [
              {
                name: "spawn_task",
                args: { title: "查天气", instructions: "查询北京今天的天气" },
              },
            ],
          },
          { text: "已安排" },
        ],
        [{ toolCalls: [{ name: "slow_wait", args: {} }] }],
      ),
    );

    const taskId = "t1";
    const stub = task(taskId);
    await installSlowWait(stub);

    const butlerStub = butler("chat-104");
    await butlerStub.handleMessage(
      message({ text: "帮我查天气", eventId: "tg:104" }),
    );

    const progress = channel.sent.find(
      (msg) => msg.text === "#1 查天气：已开始",
    );
    expect(progress).toBeUndefined();
    expect(channel.sent.at(-1)).toEqual({ chatId: "42", text: "已安排" });

    expect(await stub.status()).toMatchObject({
      state: "running",
      title: "查天气",
    });

    const row = await runInDurableObject(butlerStub, (_instance, state) =>
      state.storage.sql
        .exec<{ id: string; title: string; chat_id: string }>(
          `SELECT id, title, chat_id FROM tasks WHERE id = ?`,
          taskId,
        )
        .toArray()[0],
    );
    expect(row).toMatchObject({
      id: "t1",
      title: "查天气",
      chat_id: JSON.stringify({
        channel: "telegram",
        conversationId: "42",
      }),
    });

    await releaseSlowTask(stub);
    await vi.waitFor(
      async () => {
        expect((await stub.status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );
  });

  it("carries an inbox attachment from spawn_task through to the task", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const key = "inbox/tg:1/a.md";
    await env.ARTIFACTS.put(key, "# 附件正文", {
      httpMetadata: { contentType: "text/markdown" },
    });
    let seen: TranscriptContext | undefined;
    setModelOverride(
      routedModel(
        [
          {
            toolCalls: [
              {
                name: "spawn_task",
                args: {
                  title: "读附件",
                  instructions: "读一下附件",
                  attachments: [key],
                },
              },
            ],
          },
          { text: "已安排" },
        ],
        [
          { toolCalls: [{ name: "get_artifact", args: { ref: key } }] },
          {
            toolCalls: [
              { name: "finish_task", args: { summary: "读完" } },
            ],
            observe: (context) => {
              seen = context;
            },
          },
        ],
      ),
    );

    const butlerStub = butler("chat-attachment-wiring");
    // Task ids restart at t1 for every Butler, so move the counter past the
    // task the spawn test above already ran in this suite.
    const taskId = await runInDurableObject(butlerStub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('task_counter', '900')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      return "t901";
    });
    const stub = task(taskId);
    await butlerStub.handleMessage(
      message({ text: "读一下附件", eventId: "tg:attachment-wiring" }),
    );

    const storedSpec = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ value: string }>(
          `SELECT value FROM meta WHERE key = 'spec'`,
        )
        .toArray()[0]?.value,
    );
    expect(JSON.parse(storedSpec ?? "{}")).toMatchObject({
      attachments: [
        {
          name: "a.md",
          key,
          mimeType: "text/markdown",
          size: new TextEncoder().encode("# 附件正文").byteLength,
        },
      ],
    });

    await vi.waitFor(
      () => {
        expect(JSON.stringify(seen?.messages)).toContain("# 附件正文");
      },
      { timeout: 10_000 },
    );
    // The task finishing is a second, late report from the Butler: wait for
    // it here so it cannot land on the next test's fake channel.
    await vi.waitFor(
      () => {
        expect(
          channel.sent.some((sent) => sent.text.includes("读完")),
        ).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect(channel.sent.some((sent) => sent.text === "已安排")).toBe(true);
  });

  it("drops an input whose admitted route is no longer current", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let calls = 0;
    setModelOverride(
      scriptedModel([
        {
          text: "不应出现",
          observe: () => {
            calls += 1;
          },
        },
      ]),
    );

    await butler("chat-107").handleMessage({
      ...message({ text: "你好", eventId: "tg:107" }),
      routeKey: "stale-route",
    });

    expect(channel.sent).toEqual([]);
    expect(calls).toBe(0);
  });

  it("answers through sendCurrent after the selection changes mid-run", async () => {
    const stub = butler("chat-108");
    const sends: OutboundMessage[] = [];
    const explicitTargets: string[] = [];
    const routes: RouteSnapshot[] = [
      { channel: "telegram", routeKey: "k1" },
      { channel: "wechat", routeKey: "k2" },
    ];
    let index = 0;

    await runInDurableObject(stub, (instance) => {
      (
        instance as unknown as { channels(): unknown }
      ).channels = () => ({
        currentRoute: async () => routes[Math.min(index, 1)],
        // The input was admitted before the flip; the model is still running.
        isAdmissionCurrent: async () => true,
        sendCurrent: async (msg: OutboundMessage) => {
          sends.push(msg);
          const current = routes[Math.min(index, 1)]!;
          return {
            channel: current.channel!,
            conversationId: "42",
            routeKey: current.routeKey,
            messageId: "1",
          };
        },
        editCurrent: async () => true,
        send: async () => {
          explicitTargets.push("send");
        },
        edit: async () => {
          explicitTargets.push("edit");
        },
      });
    });

    setModelOverride(
      scriptedModel([
        {
          text: "done",
          observe: () => {
            index = 1;
          },
        },
      ]),
    );

    await stub.handleMessage(
      message({ text: "你好", eventId: "tg:108" }),
    );

    expect(sends.at(-1)).toEqual({ text: "done", priority: "critical" });
    // The Butler never caches or names an output channel itself.
    expect(explicitTargets).toEqual([]);
  });

  it("re-presents a pending approval after the owner's next admitted message", async () => {
    const stub = butler("chat-109");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO tasks
          (id, title, status, created_at, updated_at, chat_id, artifacts_json, last_seq)
         VALUES ('t1', '查天气', 'running', 0, 0, NULL, '[]', 0)`,
      );
    });

    const sends: OutboundMessage[] = [];
    let failSend = true;
    const route: RouteSnapshot = { channel: "wechat", routeKey: "wx-route" };

    await runInDurableObject(stub, (instance) => {
      (
        instance as unknown as { channels(): unknown }
      ).channels = () => ({
        currentRoute: async () => route,
        isAdmissionCurrent: async (channel: string, key: string) =>
          channel === "wechat" && key === "wx-route",
        sendCurrent: async (msg: OutboundMessage) => {
          if (failSend) throw new Error("wechat context missing");
          sends.push(msg);
          return {
            channel: "wechat",
            conversationId: "u1",
            routeKey: "wx-route",
            messageId: null,
          };
        },
        editCurrent: async () => false,
      });
      (
        instance as unknown as { taskFor(id: string): unknown }
      ).taskFor = () => ({
        start: async () => {},
        status: async () => ({ state: "running", title: "" }),
        steer: async () => ({ ok: false, message: "" }),
        cancel: async () => ({ ok: false, message: "" }),
        retryTask: async () => ({ ok: false, message: "" }),
        pendingApprovals: async () => [
          {
            approvalId: "ap1",
            tool: "web_fetch",
            argsSummary: "https://x",
            reason: "对外发送",
          },
        ],
      });
    });

    setModelOverride(scriptedModel([{ text: "收到" }]));

    // No WeChat context yet: the approval stays pending for a later try.
    await stub.reconcileChannel("wx-route");
    expect(sends).toEqual([]);

    // The owner's first message creates the context; the reply is sent and
    // the approval is presented through the same channel.
    failSend = false;
    await stub.handleMessage({
      type: "message",
      channel: "wechat",
      chatId: "u1",
      userId: "1",
      text: "你好",
      eventId: "wx:109",
      routeKey: "wx-route",
    });

    await vi.waitFor(
      () => {
        expect(sends.filter((msg) => msg.text.includes("请求执行"))).toHaveLength(1);
        expect(sends.some((msg) => msg.text.includes("\n对外发送\n"))).toBe(true);
        expect(sends.some((msg) => msg.text === "收到")).toBe(true);
      },
      { timeout: 10_000 },
    );
  });
});
