import type { TranscriptContext } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setBotChatOverrides,
  type BotChatButler,
} from "../../src/bot/bot-chat-do";
import type { BotSelf } from "../../src/bot/bot-chat-tools";
import type { BotSnapshot } from "../../src/bot/bot-do";
import type { BotMeta, RunRow } from "../../src/bot/bot-store";
import { RULES_DOC, type BotDoc } from "../../src/bot/docs";
import { t } from "../../src/i18n";
import {
  QUOTA_EXHAUSTED_TEXT,
  WORKERS_AI_QUOTA_MARKER,
  modelUnavailableText,
} from "../../src/llm/model-errors";
import { setModelOverride } from "../../src/llm/models";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

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

function chatStub(name: string) {
  return env.BOT_CHAT.get(env.BOT_CHAT.idFromName(name));
}

type ChatStub = ReturnType<typeof chatStub>;

function snapshot(
  patch: Partial<BotMeta> = {},
  docs: BotDoc[] = [],
  runs: RunRow[] = [],
): BotSnapshot {
  return {
    meta: {
      botId: "b1",
      name: "盯盘",
      mission: "盯着价格",
      status: "active",
      nextWakeAt: Date.UTC(2030, 0, 1, 9, 0, 0),
      defaultIntervalMs: 86_400_000,
      currentTaskId: null,
      consecutiveFailures: 0,
      wakesDay: null,
      wakesCount: 0,
      pendingSteer: [],
      ...patch,
    },
    docs,
    runs,
  };
}

type Call = { method: string; args: unknown[] };

type FakeSelf = {
  calls: Call[];
  snapshot: BotSnapshot | null;
  writeResult: { ok: boolean; message: string };
  wakeResult: "scheduled" | "after_run" | "inactive";
  intervalResult: {
    defaultIntervalMs: number;
    nextWakeAt: number | null;
  } | null;
  runs: RunRow[];
  nextWake: { at: number; clamped: boolean };
};

function fakeSelf(initial: BotSnapshot | null = snapshot()): {
  self: BotSelf;
  state: FakeSelf;
} {
  const state: FakeSelf = {
    calls: [],
    snapshot: initial,
    writeResult: { ok: true, message: "已写入" },
    wakeResult: "scheduled",
    intervalResult: { defaultIntervalMs: 300_000, nextWakeAt: null },
    runs: [],
    nextWake: { at: Date.UTC(2030, 2, 1), clamped: false },
  };

  const self: BotSelf = {
    async snapshot() {
      state.calls.push({ method: "snapshot", args: [] });
      return state.snapshot;
    },
    async writeDoc(name, content, options) {
      state.calls.push({ method: "writeDoc", args: [name, content, options] });
      return state.writeResult;
    },
    async wakeNow() {
      state.calls.push({ method: "wakeNow", args: [] });
      return state.wakeResult;
    },
    async pause() {
      state.calls.push({ method: "pause", args: [] });
    },
    async resume(wakeNow) {
      state.calls.push({ method: "resume", args: [wakeNow] });
    },
    async setDefaultInterval(ms) {
      state.calls.push({ method: "setDefaultInterval", args: [ms] });
      return state.intervalResult;
    },
    async steer(text, options) {
      state.calls.push({ method: "steer", args: [text, options] });
      return { currentTaskId: null };
    },
    async searchRuns(keyword) {
      state.calls.push({ method: "searchRuns", args: [keyword] });
      return state.runs;
    },
    async setNextWake(req) {
      state.calls.push({ method: "setNextWake", args: [req] });
      return state.nextWake;
    },
  };

  return { self, state };
}

function fakeButler(profile = "- 时区 UTC+8"): {
  butler: BotChatButler;
  notices: { botId: string; text: string }[];
} {
  const notices: { botId: string; text: string }[] = [];
  return {
    notices,
    butler: {
      async notifyFromBot(botId, text) {
        notices.push({ botId, text });
        return true;
      },
      async ownerProfile() {
        return profile;
      },
    },
  };
}

function install(bot: ReturnType<typeof fakeSelf>, butler: BotChatButler): void {
  setBotChatOverrides({ bot: () => bot.self, butler });
}

/** The rendered system sections, flattened to text for assertions. */
function systemText(context: TranscriptContext | undefined): string {
  if (context === undefined) return "";
  return context.messages
    .filter((entry) => entry.role === "system")
    .map((entry) => {
      const sections = (entry as { sections?: unknown }).sections;
      return sections === undefined ? "" : JSON.stringify(sections);
    })
    .join("\n");
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

function withoutSnapshot(calls: Call[]): Call[] {
  return calls.filter((call) => call.method !== "snapshot");
}

function chat(
  stub: ChatStub,
  botId: string,
  text: string,
  eventId: string,
): Promise<void> {
  return stub.chat({ botId, text, eventId });
}

afterEach(() => {
  setBotChatOverrides({ butler: null, bot: null });
  setModelOverride(null);
  restoreEnv();
});

describe("bot chat", () => {
  it("destroy clears the transcript", async () => {
    const bot = fakeSelf();
    const butler = fakeButler();
    install(bot, butler.butler);
    const botId = "destroy-bot";

    setModelOverride(scriptedModel([{ text: "第一轮回答" }]));
    const stub = chatStub(botId);
    await chat(stub, botId, "第一句话", "e1");
    expect(butler.notices).toEqual([{ botId, text: "第一轮回答" }]);

    await stub.destroy();
    // Agent.destroy() aborts the isolate on a later tick. Yield one so the
    // abort lands before the next stub's RPC; otherwise that RPC races the
    // teardown and fails with "destroyed".
    await new Promise((resolve) => setTimeout(resolve, 0));

    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        {
          text: "第二轮回答",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );
    await chat(chatStub(botId), botId, "第二句话", "e2");

    expect(JSON.stringify(seen?.messages)).not.toContain("第一句话");
    expect(JSON.stringify(seen?.messages)).not.toContain("第一轮回答");
    expect(butler.notices.at(-1)).toEqual({ botId, text: "第二轮回答" });
  });

  it("persists the bot id for a resumed turn", async () => {
    const bot = fakeSelf();
    install(bot, fakeButler().butler);
    const botId = "persist-bot-id";
    setModelOverride(scriptedModel([{ text: "好" }]));
    const stub = chatStub(botId);

    await chat(stub, botId, "你好", "e-persist-bot-id");

    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.kv.get("botId"),
    );
    expect(stored).toBe(botId);
  });

  it("answers from the bot's snapshot", async () => {
    const bot = fakeSelf(
      snapshot(
        { status: "paused", name: "盯盘" },
        [
          { name: RULES_DOC, content: "不要半夜通知" },
          { name: "盯盘方法", content: "先看主站" },
          { name: "记忆", content: "上次价格 239" },
        ],
        [
          {
            taskId: "t1",
            startedAt: 100,
            endedAt: 200,
            outcome: "completed",
            summary: "价格没变",
            note: null,
          },
        ],
      ),
    );
    const butler = fakeButler("- 时区 UTC+8");
    install(bot, butler.butler);
    const botId = "snapshot-bot";

    let prompt = "";
    setModelOverride(
      scriptedModel([
        {
          text: "价格回落了",
          observe: (context) => {
            prompt = systemText(context);
          },
        },
      ]),
    );

    await chat(chatStub(botId), botId, "最近怎样", "e-snapshot");

    expect(prompt).toContain("盯盘");
    expect(prompt).toContain("盯着价格");
    expect(prompt).toContain("状态：已暂停");
    expect(prompt).toContain(
      `下次唤醒：${new Date(Date.UTC(2030, 0, 1, 9)).toISOString()}`,
    );
    expect(prompt).toContain("默认间隔：1d");
    expect(prompt).toContain("不要半夜通知");
    expect(prompt).toContain("盯盘方法");
    expect(prompt).toContain("先看主站");
    expect(prompt).toContain("上次价格 239");
    expect(prompt).toContain("价格没变");
    expect(prompt).toContain("时区 UTC+8");
    expect(butler.notices).toEqual([{ botId, text: "价格回落了" }]);
  });

  it("run_now steers and wakes the bot", async () => {
    const bot = fakeSelf();
    install(bot, fakeButler().butler);
    const botId = "run-now-bot";
    let tool = "";

    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "run_now", args: { instruction: "查一次" } }] },
        {
          text: "已安排",
          observe: (context) => {
            tool = toolResultText(context);
          },
        },
      ]),
    );

    await chat(chatStub(botId), botId, "立刻查一次", "e-run-now");

    expect(withoutSnapshot(bot.state.calls)).toEqual([
      { method: "steer", args: ["查一次", { fromChat: true }] },
      { method: "wakeNow", args: [] },
    ]);
    expect(tool).toBe("已安排立即唤醒");
  });

  it("run_now reports a run already in flight", async () => {
    const bot = fakeSelf();
    bot.state.wakeResult = "after_run";
    install(bot, fakeButler().butler);
    const botId = "run-now-after-bot";
    let tool = "";

    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "run_now", args: { instruction: "查一次" } }] },
        {
          text: "好",
          observe: (context) => {
            tool = toolResultText(context);
          },
        },
      ]),
    );

    await chat(chatStub(botId), botId, "查一次", "e-run-now-after");

    expect(tool).toBe("正在运行，结束后约 5 分钟再唤醒");
  });

  it("run_now reports a paused or finished bot", async () => {
    const bot = fakeSelf();
    bot.state.wakeResult = "inactive";
    install(bot, fakeButler().butler);
    const botId = "run-now-inactive-bot";
    let tool = "";

    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "run_now", args: { instruction: "查一次" } }] },
        {
          text: "好",
          observe: (context) => {
            tool = toolResultText(context);
          },
        },
      ]),
    );

    await chat(chatStub(botId), botId, "查一次", "e-run-now-inactive");

    expect(tool).toBe("已暂停或已完成，先恢复再唤醒");
  });

  it("write_doc writes the document with rules allowed", async () => {
    const bot = fakeSelf();
    bot.state.writeResult = { ok: true, message: "已写入「方法」" };
    install(bot, fakeButler().butler);
    const botId = "write-doc-bot";
    let tool = "";

    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "write_doc",
              args: { name: "方法", content: "先看主站" },
            },
          ],
        },
        {
          text: "记下了",
          observe: (context) => {
            tool = toolResultText(context);
          },
        },
      ]),
    );

    await chat(chatStub(botId), botId, "记一下方法", "e-write-doc");

    expect(withoutSnapshot(bot.state.calls)).toEqual([
      {
        method: "writeDoc",
        args: ["方法", "先看主站", { allowRules: true }],
      },
    ]);
    expect(tool).toBe("已写入「方法」");
  });

  it("search_runs searches this bot's runs", async () => {
    const bot = fakeSelf();
    bot.state.runs = [
      {
        taskId: "t1",
        startedAt: 100,
        endedAt: 200,
        outcome: "completed",
        summary: "价格没变",
        note: null,
      },
    ];
    install(bot, fakeButler().butler);
    const botId = "search-runs-bot";
    let tool = "";

    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "search_runs", args: { keyword: "价格" } }] },
        {
          text: "找到一条",
          observe: (context) => {
            tool = toolResultText(context);
          },
        },
      ]),
    );

    await chat(chatStub(botId), botId, "查查记录", "e-search-runs");

    expect(withoutSnapshot(bot.state.calls)).toEqual([
      { method: "searchRuns", args: ["价格"] },
    ]);
    expect(tool).toContain("t1");
    expect(tool).toContain("价格没变");
  });

  it("set_next_wake parses a duration", async () => {
    const bot = fakeSelf();
    install(bot, fakeButler().butler);
    const botId = "set-next-wake-bot";
    let tool = "";

    setModelOverride(
      scriptedModel([
        {
          toolCalls: [{ name: "set_next_wake", args: { after: "2h" } }],
        },
        {
          text: "好",
          observe: (context) => {
            tool = toolResultText(context);
          },
        },
      ]),
    );

    await chat(chatStub(botId), botId, "两小时后再看", "e-set-next-wake");

    expect(withoutSnapshot(bot.state.calls)).toEqual([
      { method: "setNextWake", args: [{ afterMs: 7_200_000 }] },
    ]);
    expect(tool).toContain(new Date(bot.state.nextWake.at).toISOString());
  });

  it("set_interval rejects an interval below the minimum", async () => {
    const bot = fakeSelf();
    install(bot, fakeButler().butler);
    const botId = "set-interval-reject-bot";
    let tool = "";

    setModelOverride(
      scriptedModel([
        {
          toolCalls: [{ name: "set_interval", args: { interval: "1m" } }],
        },
        {
          text: "好",
          observe: (context) => {
            tool = toolResultText(context);
          },
        },
      ]),
    );

    await chat(chatStub(botId), botId, "改成 1m", "e-set-interval-reject");

    expect(withoutSnapshot(bot.state.calls)).toEqual([]);
    expect(tool).toBe("时长超出范围：1m（最短 5m，最长 30d）");
  });

  it("set_interval rejects an unparseable interval", async () => {
    const bot = fakeSelf();
    install(bot, fakeButler().butler);
    const botId = "set-interval-invalid-bot";
    let tool = "";

    setModelOverride(
      scriptedModel([
        {
          toolCalls: [{ name: "set_interval", args: { interval: "abc" } }],
        },
        {
          text: "好",
          observe: (context) => {
            tool = toolResultText(context);
          },
        },
      ]),
    );

    await chat(chatStub(botId), botId, "改成 abc", "e-set-interval-invalid");

    expect(withoutSnapshot(bot.state.calls)).toEqual([]);
    expect(tool).toBe("时长格式无效：abc（示例：30m、2h、1d）");
  });

  it("set_interval applies a valid interval", async () => {
    const bot = fakeSelf();
    const nextWakeAt = Date.UTC(2030, 0, 1, 10);
    bot.state.intervalResult = {
      defaultIntervalMs: 600_000,
      nextWakeAt,
    };
    install(bot, fakeButler().butler);
    const botId = "set-interval-bot";
    let tool = "";

    setModelOverride(
      scriptedModel([
        {
          toolCalls: [{ name: "set_interval", args: { interval: "10m" } }],
        },
        {
          text: "好",
          observe: (context) => {
            tool = toolResultText(context);
          },
        },
      ]),
    );

    await chat(chatStub(botId), botId, "改成 10m", "e-set-interval");

    expect(withoutSnapshot(bot.state.calls)).toEqual([
      { method: "setDefaultInterval", args: [600_000] },
    ]);
    expect(tool).toBe(
      `已将默认间隔改为 10m，下次唤醒：${new Date(nextWakeAt).toISOString()}`,
    );
  });

  it("pause pauses the bot", async () => {
    const bot = fakeSelf();
    install(bot, fakeButler().butler);
    const botId = "pause-bot";

    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "pause", args: {} }] },
        { text: "好" },
      ]),
    );

    await chat(chatStub(botId), botId, "先停一下", "e-pause");

    expect(withoutSnapshot(bot.state.calls)).toEqual([
      { method: "pause", args: [] },
    ]);
  });

  it("resume resumes the bot", async () => {
    const bot = fakeSelf();
    install(bot, fakeButler().butler);
    const botId = "resume-bot";

    setModelOverride(
      scriptedModel([
        {
          toolCalls: [{ name: "resume", args: { wake_now: true } }],
        },
        { text: "好" },
      ]),
    );

    await chat(chatStub(botId), botId, "继续吧", "e-resume");

    expect(withoutSnapshot(bot.state.calls)).toEqual([
      { method: "resume", args: [true] },
    ]);
  });

  it("resume without wake_now does not wake the bot", async () => {
    const bot = fakeSelf();
    install(bot, fakeButler().butler);
    const botId = "resume-default-bot";

    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "resume", args: {} }] },
        { text: "好" },
      ]),
    );

    await chat(chatStub(botId), botId, "继续吧", "e-resume-default");

    expect(withoutSnapshot(bot.state.calls)).toEqual([
      { method: "resume", args: [false] },
    ]);
  });

  it("a rules write sends the confirmation as its own message", async () => {
    const bot = fakeSelf();
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "rules-confirm-bot";

    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "write_doc",
              args: { name: " 守则 ", content: " 不要半夜通知 " },
            },
          ],
        },
        { text: "好的" },
      ]),
    );

    await chat(chatStub(botId), botId, "加一条守则", "e-rules-confirm");

    expect(withoutSnapshot(bot.state.calls)).toEqual([
      {
        method: "writeDoc",
        args: [" 守则 ", " 不要半夜通知 ", { allowRules: true }],
      },
    ]);
    expect(notices).toEqual([
      { botId, text: "好的" },
      {
        botId,
        text: t("zh", "butler.botChat.rulesUpdated", {
          rules: "不要半夜通知",
        }),
      },
    ]);
  });

  it("truncates a long rules confirmation and says how long it was", async () => {
    const bot = fakeSelf();
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "rules-long-bot";
    const rules = "x".repeat(300);

    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            { name: "write_doc", args: { name: RULES_DOC, content: rules } },
          ],
        },
        { text: "好的" },
      ]),
    );

    await chat(chatStub(botId), botId, "加一条长守则", "e-rules-long");

    expect(notices).toEqual([
      { botId, text: "好的" },
      {
        botId,
        text: t("zh", "butler.botChat.rulesUpdated", {
          rules:
            "x".repeat(200) +
            t("zh", "butler.botChat.rulesTruncated", { count: 300 }),
        }),
      },
    ]);
  });

  it("a rules write outside a turn notifies immediately", async () => {
    const bot = fakeSelf();
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "rules-outside-turn-bot";

    // A turn first, so the chat has stored its bot id as an alarm resume
    // would have done.
    setModelOverride(scriptedModel([{ text: "第一轮回答" }]));
    const stub = chatStub(botId);
    await chat(stub, botId, "你好", "e-outside-first");
    expect(notices).toEqual([{ botId, text: "第一轮回答" }]);

    // A resumed turn runs the tool outside runTurn, so no `chat()` is active.
    await runInDurableObject(stub, async (instance) => {
      const writeDoc = instance.registry
        .snapshot()
        .tools()
        .find(({ tool }) => tool.name === "write_doc");
      expect(writeDoc).toBeDefined();
      await writeDoc!.tool.execute(
        { name: RULES_DOC, content: "不要半夜通知" },
        undefined as never,
        undefined as never,
      );
    });

    await vi.waitFor(() => expect(notices).toHaveLength(2));
    expect(notices[1]).toEqual({
      botId,
      text: t("zh", "butler.botChat.rulesUpdated", {
        rules: "不要半夜通知",
      }),
    });
  });

  it("a rules write without reply text still sends the confirmation", async () => {
    const bot = fakeSelf();
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "rules-no-reply-bot";

    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            { name: "write_doc", args: { name: RULES_DOC, content: "不要半夜通知" } },
          ],
        },
        { text: "" },
      ]),
    );

    await chat(chatStub(botId), botId, "加一条守则", "e-rules-no-reply");

    expect(notices).toEqual([
      {
        botId,
        text: t("zh", "butler.botChat.rulesUpdated", {
          rules: "不要半夜通知",
        }),
      },
    ]);
  });

  it("deleting the rules confirms the deletion", async () => {
    const bot = fakeSelf();
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "rules-delete-bot";

    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            { name: "write_doc", args: { name: RULES_DOC, content: "" } },
          ],
        },
        { text: "" },
      ]),
    );

    await chat(chatStub(botId), botId, "删掉守则", "e-rules-delete");

    expect(notices).toEqual([
      { botId, text: t("zh", "butler.botChat.rulesDeleted") },
    ]);
  });

  it("a method write adds no confirmation", async () => {
    const bot = fakeSelf();
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "method-write-bot";

    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            { name: "write_doc", args: { name: "方法", content: "先看主站" } },
          ],
        },
        { text: "好的" },
      ]),
    );

    await chat(chatStub(botId), botId, "记一下方法", "e-method-write");

    expect(notices).toEqual([{ botId, text: "好的" }]);
  });

  it("a repeated eventId is answered once", async () => {
    const bot = fakeSelf();
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "dedupe-bot";

    setModelOverride(scriptedModel([{ text: "只回一次" }]));

    const stub = chatStub(botId);
    await chat(stub, botId, "你好", "same-event");
    await chat(stub, botId, "你好", "same-event");

    expect(notices).toEqual([{ botId, text: "只回一次" }]);
  });

  it("two concurrent chats run one after another", async () => {
    const bot = fakeSelf();
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "concurrent-bot";
    let seen: TranscriptContext | undefined;

    setModelOverride(
      scriptedModel([
        { text: "第一轮回答" },
        {
          text: "第二轮回答",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );

    const stub = chatStub(botId);
    const first = chat(stub, botId, "第一句", "e-first");
    const second = chat(stub, botId, "第二句", "e-second");
    await Promise.all([first, second]);

    expect(JSON.stringify(seen?.messages)).toContain("第一轮回答");
    expect(notices).toEqual([
      { botId, text: "第一轮回答" },
      { botId, text: "第二轮回答" },
    ]);
  });

  it("a new model applies to an existing chat", async () => {
    const bot = fakeSelf();
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "model-switch-bot";

    // Both providers must be in the catalog before the harness opens, so
    // switching only changes the model reference, as it does in production.
    const modelA = scriptedModel([{ text: "来自 A" }]);
    const modelB = scriptedModel([{ text: "来自 B" }]);

    const stub = chatStub(botId);
    setModelOverride(modelA);
    await chat(stub, botId, "你好", "e-model-a");

    setModelOverride(modelB);
    await chat(stub, botId, "再说一次", "e-model-b");

    expect(notices).toEqual([
      { botId, text: "来自 A" },
      { botId, text: "来自 B" },
    ]);
  });

  it("a much smaller model is refused like the Butler's model switch", async () => {
    const bot = fakeSelf();
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "window-downgrade-bot";
    let smallCalls = 0;

    const large = scriptedModel([{ text: "大窗口回答" }], {
      contextWindow: 128000,
    });
    const small = scriptedModel(
      [
        {
          text: "不应出现",
          observe: () => {
            smallCalls += 1;
          },
        },
      ],
      { contextWindow: 16000 },
    );

    const stub = chatStub(botId);
    setModelOverride(large);
    await chat(stub, botId, "你好", "e-window-large");

    setModelOverride(small);
    await chat(stub, botId, "再说一次", "e-window-small");

    expect(smallCalls).toBe(0);
    expect(notices[0]).toEqual({ botId, text: "大窗口回答" });
    expect(notices).toHaveLength(2);
    expect(notices[1]?.text).toContain("128000");
    expect(notices[1]?.text).toContain("16000");
  });

  it("a missing snapshot answers deleted without calling the model", async () => {
    const bot = fakeSelf(null);
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "deleted-bot";
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

    await chat(chatStub(botId), botId, "你好", "e-deleted");

    expect(notices).toEqual([
      { botId, text: t("zh", "butler.botChat.deleted") },
    ]);
    expect(calls).toBe(0);
  });

  it("a blocked model answers with the gate copy", async () => {
    const bot = fakeSelf();
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "blocked-bot";
    setModelOverride(null);
    setEnv({
      DESKWAND_CONFIG: {
        schemaVersion: 1,
        owner: { telegramUserIds: [100000001] },
        models: {
          butler: { provider: "opencode-go", id: "does-not-exist" },
          task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
        },
        mcpServers: [],
      },
    });

    await chat(chatStub(botId), botId, "你好", "e-blocked");

    expect(notices).toEqual([
      {
        botId,
        text: modelUnavailableText("zh", "opencode-go", "does-not-exist"),
      },
    ]);
  });

  it("a model error answers with the unanswered copy", async () => {
    const bot = fakeSelf();
    const { butler, notices } = fakeButler();
    install(bot, butler);
    const botId = "model-error-bot";

    setModelOverride(scriptedModel([{ error: WORKERS_AI_QUOTA_MARKER }]));

    await chat(chatStub(botId), botId, "你好", "e-model-error");

    expect(notices).toEqual([{ botId, text: QUOTA_EXHAUSTED_TEXT }]);
  });
});
