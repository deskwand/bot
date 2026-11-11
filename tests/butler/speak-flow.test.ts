import type { TranscriptContext } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotsRepo } from "../../src/butler/bots-repo";
import type { LedgerRow } from "../../src/butler/ledger";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import type { ChannelMessageRef, OutboundMessage } from "../../src/protocol";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

beforeEach(async () => {
  await seedOwnerAddress("42");
});

afterEach(() => {
  setChannelOverride("telegram", null);
  setModelOverride(null);
  vi.restoreAllMocks();
});

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

type ButlerStub = ReturnType<typeof butler>;

async function seedTask(
  stub: ButlerStub,
  row: {
    id?: string;
    title?: string;
    status?: string;
    chatId?: string | null;
    botId?: string | null;
  } = {},
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO tasks
        (id, title, status, created_at, updated_at, chat_id, artifacts_json,
         last_seq, bot_id)
       VALUES (?, ?, ?, 0, 0, ?, '[]', 0, ?)`,
      row.id ?? "t1",
      row.title ?? "查机票",
      row.status ?? "queued",
      row.chatId === undefined ? "42" : row.chatId,
      row.botId ?? null,
    );
  });
}

async function seedBot(
  stub: ButlerStub,
  id: string,
  name: string,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    new BotsRepo(state.storage.sql).insert({ id, name });
  });
}

function pending(stub: ButlerStub): Promise<{
  rows: LedgerRow[];
  ids: number[];
  omitted: number;
}> {
  return runInDurableObject(stub, (instance) => instance.ledger.pending());
}

/** The last user message the model saw, as plain text. */
function lastUserText(
  context: TranscriptContext | undefined,
): string | undefined {
  const last = context?.messages
    .filter((entry) => entry.role === "user")
    .at(-1);
  if (last === undefined) return undefined;
  if (typeof last.content === "string") return last.content;
  return last.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("butler speak flow", () => {
  it("sends the rewritten completion and records what it said", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([{ text: "查到了，最早 7:20，680 元。" }]),
    );
    const stub = butler("speak-completed");
    await seedTask(stub);

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "最早 7:20，680 元",
      artifacts: [],
    });

    expect(channel.sent.map((message) => message.text)).toEqual([
      "查到了，最早 7:20，680 元。",
    ]);
    const unread = await pending(stub);
    expect(unread.rows).toHaveLength(1);
    expect(unread.rows[0]).toMatchObject({
      kind: "butler.said",
      refId: "t1",
      line: "我对主人说了：查到了，最早 7:20，680 元。",
    });
    expect(unread.rows.some((row) => row.kind === "task.completed")).toBe(
      false,
    );
  });

  it("says a task with no summary is done before sending artifacts", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const observe = vi.fn();
    setModelOverride(scriptedModel([{ text: "不应出现", observe }]));
    const stub = butler("speak-empty-summary");
    await seedTask(stub);
    await env.ARTIFACTS.put("t1/f1/report.md", "# body", {
      httpMetadata: { contentType: "text/markdown" },
    });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "",
      artifacts: [{ name: "report.md", key: "t1/f1/report.md" }],
    });

    expect(channel.sent.map((message) => message.text)).toEqual([
      "「查机票」办好了。",
    ]);
    expect(channel.artifacts).toEqual([
      { chatId: "42", name: "report.md", contentType: "text/markdown" },
    ]);
    expect(observe).not.toHaveBeenCalled();
  });

  it("falls back to the original failure when the model throws", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ error: "boom" }]));
    const stub = butler("speak-failed");
    await seedTask(stub);

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "failed",
      reason: "航班接口超时",
      retryable: true,
    });

    expect(channel.sent.map((message) => message.text)).toEqual([
      "「查机票」没办成：航班接口超时\n要我重试吗？",
    ]);
  });

  it("sends a rewritten stall as an alert", async () => {
    const stub = butler("speak-stalled");
    await seedTask(stub, { status: "running" });
    setModelOverride(
      scriptedModel([{ text: "还在查，web_fetch 已经 10 分钟没返回了。" }]),
    );
    const sent: OutboundMessage[] = [];
    await runInDurableObject(stub, (instance) => {
      (
        instance as unknown as {
          channels(): {
            currentRoute(): Promise<{ channel: "telegram"; routeKey: string }>;
            isAdmissionCurrent(): Promise<boolean>;
            editCurrent(): Promise<boolean>;
            sendCurrent(msg: OutboundMessage): Promise<ChannelMessageRef>;
          };
        }
      ).channels = () => ({
        currentRoute: async () => ({
          channel: "telegram",
          routeKey: "test-route",
        }),
        isAdmissionCurrent: async () => true,
        editCurrent: async () => false,
        sendCurrent: async (msg) => {
          sent.push(msg);
          return {
            channel: "telegram",
            conversationId: "42",
            routeKey: "test-route",
            messageId: String(sent.length),
          };
        },
      });
    });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "stalled",
      activity: { kind: "running_tool", tool: "web_fetch" },
      idleMs: 600_000,
    });

    expect(sent).toEqual([
      {
        text: "还在查，web_fetch 已经 10 分钟没返回了。",
        priority: "alert",
      },
    ]);
  });

  it("speaks a bot message without the bracket prefix", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([{ text: "盯盘那边发现茅台跌破 1500 了。" }]),
    );
    const stub = butler("speak-notify");
    await seedBot(stub, "b1", "盯盘");

    const delivered = await stub.notifyFromBot("b1", "茅台跌破 1500");

    expect(delivered).toBe(true);
    expect(channel.sent.map((message) => message.text)).toEqual([
      "盯盘那边发现茅台跌破 1500 了。",
    ]);
    expect(channel.sent[0]?.text).not.toContain("【");
    const unread = await pending(stub);
    expect(unread.rows).toHaveLength(1);
    expect(unread.rows[0]).toMatchObject({
      kind: "butler.said",
      refId: "b1",
      line: "我对主人说了：盯盘那边发现茅台跌破 1500 了。",
    });
  });

  it("returns false for an unknown bot without calling the model", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const observe = vi.fn();
    setModelOverride(scriptedModel([{ text: "不应出现", observe }]));
    const stub = butler("speak-notify-missing");

    expect(await stub.notifyFromBot("nope", "你好")).toBe(false);
    expect(observe).not.toHaveBeenCalled();
    expect(channel.sent).toEqual([]);
  });

  it("returns false and writes nothing when the channel fails", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", {
      ...channel.adapter,
      send: async () => {
        throw new Error("channel down");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    setModelOverride(scriptedModel([{ text: "降价了，跟你说一声。" }]));
    const stub = butler("speak-send-failure");
    await seedBot(stub, "b1", "盯盘");

    await expect(stub.notifyFromBot("b1", "降价了")).resolves.toBe(false);
    expect(await pending(stub)).toEqual({ rows: [], ids: [], omitted: 0 });
  });

  it("sends concurrent completions in order and shows the second what was said", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        { text: "价格回落了，跟你说一声。", gate },
        {
          text: "新闻也看完了。",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );
    const stub = butler("speak-concurrent");
    await seedTask(stub, { id: "t1", title: "盯价格" });
    await seedTask(stub, { id: "t2", title: "看新闻" });

    await runInDurableObject(stub, async (instance) => {
      const first = instance.report({
        taskId: "t1",
        seq: 1,
        type: "completed",
        summary: "价格回落了",
        artifacts: [],
      });
      const second = instance.report({
        taskId: "t2",
        seq: 1,
        type: "completed",
        summary: "新闻看完了",
        artifacts: [],
      });
      // Both events have arrived while the first rewrite is still blocked.
      release();
      await Promise.all([first, second]);
    });

    expect(channel.sent.map((message) => message.text)).toEqual([
      "价格回落了，跟你说一声。",
      "新闻也看完了。",
    ]);
    expect(lastUserText(seen)).toContain("价格回落了，跟你说一声。");
  });

  it("hands a bot task to its bot without speaking", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const observe = vi.fn();
    setModelOverride(scriptedModel([{ text: "不应出现", observe }]));
    const stub = butler("speak-bot-task");
    await seedTask(stub, { botId: "b1", status: "running" });
    const ended: unknown[] = [];
    await runInDurableObject(stub, (instance) => {
      (
        instance as unknown as {
          botFor(id: string): {
            onRunEnded(...args: unknown[]): Promise<void>;
          };
        }
      ).botFor = () => ({
        onRunEnded: async (...args: unknown[]) => {
          ended.push(args);
        },
      });
    });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "价格回落了",
      artifacts: [],
    });

    expect(channel.sent).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
    expect(ended).toHaveLength(1);
  });
});
