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
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { PiHarness, type PiModel } from "agents/harness/pi";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { registerTestProvider, setModelOverride } from "../../src/llm/models";
import type { AdmittedMessage, OutboundMessage, RouteSnapshot } from "../../src/protocol";
import { fakeChannel } from "../helpers/fake-channel";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const SlowWait = Type.Object({});

type SlowControl = { started: boolean; released: boolean };

type Turn = {
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
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

function message(evt: {
  text: string | null;
  eventId: string;
  channel?: AdmittedMessage["channel"];
  chatId?: string;
}): AdmittedMessage {
  return {
    type: "message",
    channel: evt.channel ?? "telegram",
    chatId: evt.chatId ?? "42",
    userId: "1",
    text: evt.text,
    eventId: evt.eventId,
    routeKey: route.routeKey,
  };
}

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
  restoreEnv();
});

describe("butler chat", () => {
  it("answers a text message", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ text: "你好！" }]));

    await butler("chat-101").handleMessage(
      message({ text: "你好", eventId: "tg:101" }),
    );

    expect(channel.sent).toEqual([{ chatId: "42", text: "你好！" }]);
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

    expect(channel.sent).toEqual([{ chatId: "42", text: "只回一次" }]);
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
      { chatId: "42", text: "目前只支持文字消息" },
    ]);
    expect(calls).toBe(0);
  });

  it("spawns a task and sends a progress message with a cancel button", async () => {
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

    const progress = channel.sent[0];
    expect(progress).toMatchObject({
      chatId: "42",
      text: "⏳ t1 查天气：已开始",
    });
    expect(progress?.buttons).toEqual([
      [{ label: "取消", data: "a:cancel:t1" }],
    ]);
    expect(channel.sent[1]).toEqual({ chatId: "42", text: "已安排" });

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

    expect(sends.at(-1)).toEqual({ text: "done" });
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
          { approvalId: "ap1", tool: "web_fetch", argsSummary: "https://x" },
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

    await vi.waitFor(() => {
      expect(sends.filter((msg) => msg.text.includes("请求执行"))).toHaveLength(1);
    });
    expect(sends.some((msg) => msg.text === "收到")).toBe(true);
  });
});
