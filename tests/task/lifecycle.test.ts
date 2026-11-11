import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PiHarness, PiSession } from "agents/harness/pi";
import { Type, type ToolResultMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  Harness,
  type ReportInfo,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { setClockOverride } from "../../src/butler/notifier";
import {
  PAID_PLAN_REQUIRED_TEXT,
  QUOTA_EXHAUSTED_TEXT,
  WORKERS_AI_PAID_PLAN_MARKER,
  WORKERS_AI_QUOTA_MARKER,
} from "../../src/llm/model-errors";
import { setModelOverride } from "../../src/llm/models";
import { PI_PROGRESS } from "../../src/llm/pi-settings";
import type { TaskSpec } from "../../src/protocol";
import { scriptedModel } from "../helpers/scripted-model";
import { fakeChannel } from "../helpers/fake-channel";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { resetLife } from "../helpers/life";

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

beforeEach(() => {
  setChannelOverride("telegram", fakeChannel().adapter);
});

afterEach(() => {
  setModelOverride(null);
  setClockOverride(null);
  setChannelOverride("telegram", null);
  vi.restoreAllMocks();
  restoreEnv();
});

function butler() {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

function task(taskId: string) {
  return env.TASK.get(env.TASK.idFromName(taskId));
}

function spec(taskId: string, instructions = "do the thing"): TaskSpec {
  return { taskId, title: `Task ${taskId}`, instructions };
}

function lastToolText(context: TranscriptContext): string {
  const result = context.messages
    .filter((message): message is ToolResultMessage => message.role === "toolResult")
    .at(-1);
  return result
    ? result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
    : "";
}

type SlowControl = { started: boolean; released: boolean };

function slowControl(instance: unknown): SlowControl | undefined {
  return (instance as { slowControl?: SlowControl }).slowControl;
}

/** A tool that blocks until the test releases it, like control.test.ts. */
async function installSlowWait(
  stub: ReturnType<typeof task>,
): Promise<void> {
  const SlowWait = Type.Object({});
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

async function waitForSlowStart(stub: ReturnType<typeof task>): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(
        await runInDurableObject(
          stub,
          (instance) => slowControl(instance)?.started ?? false,
        ),
      ).toBe(true);
    },
    { timeout: 10_000 },
  );
}

async function releaseSlow(stub: ReturnType<typeof task>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const control = slowControl(instance);
    if (control) control.released = true;
  });
}

/** Calls the DO's private report handler, as pi's `onReport` would. */
async function reportParked(stub: ReturnType<typeof task>): Promise<void> {
  const info = {
    type: "task_parked",
    task: { id: "pi-task", kind: "agent", conversationId: "1" },
  } as unknown as ReportInfo;
  await runInDurableObject(stub, async (instance) => {
    const sink = instance as unknown as {
      handleReport(error: unknown, info: ReportInfo): Promise<void>;
    };
    await sink.handleReport(undefined, info);
  });
}

async function workspaceKeys(taskId: string): Promise<string[]> {
  const page = await env.ARTIFACTS.list({ prefix: `work/${taskId}/` });
  return page.objects.map((object) => object.key);
}

describe("TaskDO lifecycle", () => {
  /** The level pi actually holds for this task's root conversation. */
  async function storedLevel(stub: ReturnType<typeof task>): Promise<string> {
    return runInDurableObject(stub, async (instance) => {
      const conversation = await (await instance.harness.pi()).root(BACKGROUND_CONTEXT);
      return (await conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel;
    });
  }

  function taskConfig(thinkingLevel?: string): Record<string, unknown> {
    return {
      DESKWAND_CONFIG: {
        schemaVersion: 1,
        owner: { telegramUserIds: [100000001] },
        models: {
          butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
          task: {
            provider: "opencode-go",
            id: "deepseek-v4.1-flash",
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          },
        },
        mcpServers: [],
      },
    };
  }

  // A model whose default differs from the role model's, so the two cases
  // cannot pass by accident. The model override bypasses the key check.
  const PINNED = { provider: "anthropic", id: "claude-haiku-4-5" };

  it("keeps the role's level when the task pins another model", async () => {
    setEnv(taskConfig("low"));
    setModelOverride(scriptedModel([{ text: "done" }]));
    const taskId = "t-pinned-role-level";
    const stub = task(taskId);

    await stub.start({ ...spec(taskId), model: PINNED });

    expect(await storedLevel(stub)).toBe("low");
  });

  it("uses the pinned model's default when the role has no level", async () => {
    setEnv(taskConfig());
    setModelOverride(scriptedModel([{ text: "done" }]));
    const taskId = "t-pinned-default";
    const stub = task(taskId);

    await stub.start({ ...spec(taskId), model: PINNED });

    // Claude Haiku 4.5 offers off, minimal, low, medium, high.
    expect(await storedLevel(stub)).toBe("medium");
  });

  it("attributes a bot's run to the bot in the ledger", async () => {
    setEnv(taskConfig());
    setModelOverride(scriptedModel([{ text: "done" }]));
    const taskId = "t-bot-spend";
    const stub = task(taskId);
    await resetLife();

    try {
      await stub.start({ ...spec(taskId), botId: "b-ledger" });

      await vi.waitFor(async () => {
        const sources = await runInDurableObject(
          env.LIFE.get(env.LIFE.idFromName("global")),
          (_instance, state) =>
            state.storage.sql
              .exec<{ source: string }>(`SELECT source FROM spend`)
              .toArray()
              .map((row) => row.source),
        );
        expect(sources).toContain("bot:b-ledger");
      });
    } finally {
      await resetLife();
    }
  });

  it("uses the substituted model's default instead of the role's level", async () => {
    const life = env.LIFE;
    const day = 86_400_000;
    const start = Date.UTC(2030, 0, 1, 9, 0, 0);
    let now = start;
    setClockOverride({
      now: () => now,
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    const books = life.get(life.idFromName("global"));
    await books.recordCredit(20, "");
    for (let index = 0; index < 7; index += 1) {
      now = start + Math.round((index + 0.5) * day);
      await books.recordSpend({
        callId: crypto.randomUUID(),
        at: now,
        source: "task:test",
        provider: "test",
        model: "test",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        usd: 1,
        priced: true,
      });
    }
    now = start + 7 * day;

    setEnv({
      DESKWAND_CONFIG: {
        schemaVersion: 1,
        owner: { telegramUserIds: [100000001] },
        models: {
          butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
          task: {
            provider: "opencode-go",
            id: "deepseek-v4.1-flash",
            thinkingLevel: "low",
          },
          frugal: { provider: "opencode-go", id: "deepseek-v4-pro" },
        },
        mcpServers: [],
      },
    });
    setModelOverride(scriptedModel([{ text: "done" }]));
    const taskId = "t-diet-level";
    const stub = task(taskId);

    try {
      await stub.start(spec(taskId));

      // deepseek-v4-pro offers off, high, max: its default is high, not low.
      expect(await storedLevel(stub)).toBe("high");
    } finally {
      // The tier books are shared with the rest of the run; make them ample.
      await life.get(life.idFromName("global")).recordCredit(1_000_000, "");
    }
  });

  it("fails non-retryably when the model key is missing", async () => {
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
    const taskId = "t-missing-key";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    const events = await butler().debugEvents(taskId);
    expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
    expect(events[1]?.payload).toEqual({
      type: "failed",
      reason:
        "模型 deepseek 没有配置 key（MODEL_KEY_DEEPSEEK），请在桌面端模型页填写",
      retryable: false,
    });
    expect(await stub.status()).toMatchObject({ state: "failed" });
  });

  it("reports started and completed when the agent calls finish_task", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
      ]),
    );
    const taskId = "t1";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
        expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
        expect(events[1]?.payload).toMatchObject({
          type: "completed",
          summary: "ok",
          artifacts: [],
        });
      },
      { timeout: 10_000 },
    );

    expect(await stub.status()).toEqual({ state: "completed", title: "Task t1" });

    // Starting the same task again is a no-op: same operation, no new events.
    await stub.start(spec(taskId));
    expect(await butler().debugEvents(taskId)).toHaveLength(2);
  });

  it("opens the pi harness with the slow progress policy", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
      ]),
    );
    const open = vi.spyOn(Harness, "open");
    const taskId = "t-progress";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
      },
      { timeout: 10_000 },
    );

    expect(open).toHaveBeenCalled();
    for (const call of open.mock.calls) {
      expect(call[1].settings).toEqual({ progress: PI_PROGRESS });
    }
    expect(PI_PROGRESS).toEqual({
      partialIntervalMs: 30_000,
      outputIntervalMs: 30_000,
    });
  });

  it("uses spec.model on the first run", async () => {
    const chosen = scriptedModel([
      { toolCalls: [{ name: "finish_task", args: { summary: "chosen" } }] },
    ]);
    const taskId = "t-model";
    const stub = task(taskId);

    await stub.start({
      ...spec(taskId),
      // Scripted providers use their own ids, outside the anthropic union.
      model: chosen as unknown as TaskSpec["model"],
    });

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
        expect(events[1]?.payload).toMatchObject({
          type: "completed",
          summary: "chosen",
        });
      },
      { timeout: 10_000 },
    );
  });

  it("resubmits a start that was left queued", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "retried" } }] },
      ]),
    );
    const taskId = "t-retry";
    const stub = task(taskId);

    // Simulate a previous start that stored its spec but died before submit.
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO meta (key, value) VALUES ('task_id', ?), ('title', ?), ('spec', ?), ('state', 'queued')`,
        taskId,
        "Task t-retry",
        JSON.stringify(spec(taskId)),
      );
    });

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
        expect(events[1]?.payload).toMatchObject({ summary: "retried" });
      },
      { timeout: 10_000 },
    );
  });

  it("reports failed when the run rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(PiHarness.prototype, "wait").mockRejectedValue(
      new Error("model exploded"),
    );
    setModelOverride(scriptedModel([{ text: "never read" }]));
    const taskId = "t-fail";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "failed",
        ]);
        expect(events[1]?.payload).toMatchObject({
          type: "failed",
          reason: "model exploded",
          retryable: false,
        });
      },
      { timeout: 10_000 },
    );

    expect((await stub.status()).state).toBe("failed");
  });

  it("reports an unanswered run as failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(PiHarness.prototype, "wait").mockResolvedValue({
      operationId: "task:t-unanswered",
      session: "1",
      status: "unanswered",
      reason: "boom",
    });
    setModelOverride(scriptedModel([{ text: "never read" }]));
    const taskId = "t-unanswered";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
        expect(events[1]?.payload).toMatchObject({
          type: "failed",
          reason: "boom",
          retryable: false,
        });
        expect(events.some((event) => event.type === "completed")).toBe(false);
      },
      { timeout: 10_000 },
    );

    expect((await stub.status()).state).toBe("failed");
  });

  it("explains an exhausted Workers AI allowance", async () => {
    const taskId = "t-quota";
    setModelOverride(scriptedModel([{ error: WORKERS_AI_QUOTA_MARKER }]));
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events[1]?.payload).toMatchObject({
          type: "failed",
          reason: QUOTA_EXHAUSTED_TEXT,
          retryable: false,
        });
      },
      { timeout: 10_000 },
    );

    expect((await stub.status()).state).toBe("failed");
  });

  it("explains a paid-plan-only model", async () => {
    const taskId = "t-paid-plan";
    setModelOverride(scriptedModel([{ error: WORKERS_AI_PAID_PLAN_MARKER }]));
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events[1]?.payload).toMatchObject({
          type: "failed",
          reason: PAID_PLAN_REQUIRED_TEXT,
          retryable: false,
        });
      },
      { timeout: 10_000 },
    );

    expect((await stub.status()).state).toBe("failed");
  });

  it("keeps the model error reason for other failures", async () => {
    const taskId = "t-model-error";
    setModelOverride(scriptedModel([{ error: "upstream exploded" }]));
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events[1]?.payload).toMatchObject({
          type: "failed",
          reason: "model_error",
          retryable: false,
        });
      },
      { timeout: 10_000 },
    );

    expect((await stub.status()).state).toBe("failed");
  });

  it("keeps the model error when the transcript cannot be read", async () => {
    const taskId = "t-transcript-unreadable";
    setModelOverride(scriptedModel([{ error: WORKERS_AI_QUOTA_MARKER }]));
    vi.spyOn(PiSession.prototype, "messages").mockRejectedValue(
      new Error("transcript unavailable"),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events[1]?.payload).toMatchObject({
          type: "failed",
          reason: "model_error",
          retryable: false,
        });
      },
      { timeout: 10_000 },
    );

    expect((await stub.status()).state).toBe("failed");
  });

  it("reports the last assistant text when finish_task was not called", async () => {
    setModelOverride(scriptedModel([{ text: "plain answer" }]));
    const taskId = "t2";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
        expect(events[1]?.payload).toMatchObject({
          type: "completed",
          summary: "plain answer",
          artifacts: [],
        });
      },
      { timeout: 10_000 },
    );

    expect((await stub.status()).state).toBe("completed");
  });

  it("only connects MCP tools when the task is queued or running", async () => {
    const taskId = `t-mcp-${crypto.randomUUID()}`;
    const stub = task(taskId);
    // Let the lifecycle finish startup first, so the onStart calls below do
    // not recursively restart it through a scheduler write.
    await stub.status();

    const result = await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as {
        setMeta(key: string, value: string): void;
        ensureMcpTools(): Promise<void>;
      };
      let calls = 0;
      target.ensureMcpTools = async () => {
        calls += 1;
      };

      target.setMeta("state", "completed");
      await instance.onStart();
      const completedCalls = calls;

      target.setMeta("state", "queued");
      await instance.onStart();
      target.setMeta("state", "running");
      await instance.onStart();

      return { completedCalls, calls };
    });

    expect(result.completedCalls).toBe(0);
    expect(result.calls).toBe(2);
  });

  it("still accepts gateway message events", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    await seedOwnerAddress("1");
    const route = await env.CHANNELS.get(
      env.CHANNELS.idFromName("channels"),
    ).currentRoute();

    // Non-text input exercises the RPC entry without opening pi, which this
    // file's Butler already set up with a different model catalog.
    await expect(
      butler().handleMessage({
        type: "message",
        channel: "telegram",
        chatId: "1",
        userId: "1",
        text: null,
        eventId: "tg:1",
        routeKey: route.routeKey,
      }),
    ).resolves.toBeUndefined();

    expect(channel.sent).toEqual([
      { chatId: "1", text: "目前只支持文字、图片和语音消息" },
    ]);
  });

  it("dedupes task events by seq", async () => {
    const taskId = "dedupe-1";
    const target = env.BUTLER.get(env.BUTLER.idFromName("dedupe-owner"));

    await target.report({ taskId, seq: 1, type: "started" });
    await target.report({ taskId, seq: 1, type: "started" });
    await target.report({ taskId, seq: 2, type: "progress", text: "a" });
    await target.report({ taskId, seq: 1, type: "started" });
    await target.report({ taskId, seq: 2, type: "progress", text: "a" });

    const events = await target.debugEvents(taskId);
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [1, "started"],
      [2, "progress"],
    ]);
  });
});

describe("TaskDO.liveness", () => {
  async function seedRunning(stub: ReturnType<typeof task>, taskId: string) {
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES
          ('task_id', ?), ('title', ?), ('spec', ?),
          ('state', 'running'), ('operation_id', ?)`,
        taskId,
        `Task ${taskId}`,
        JSON.stringify(spec(taskId)),
        `task:${taskId}`,
      );
    });
  }

  function interceptWatchRun(
    instance: unknown,
    watched: string[],
  ): void {
    (instance as { watchRun(id: string): Promise<void> }).watchRun = async (
      id,
    ) => {
      watched.push(id);
    };
  }

  it("re-attaches a running task that nothing is watching", async () => {
    const taskId = "t-liveness-idle";
    const stub = task(taskId);
    const watched: string[] = [];
    await runInDurableObject(stub, (instance) => {
      interceptWatchRun(instance, watched);
    });
    // Let startup finish first; it has no run to attach to yet.
    await stub.status();
    await seedRunning(stub, taskId);
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { watchers: number }).watchers = 0;
    });

    expect(await stub.liveness()).toEqual({
      state: "running",
      reattached: true,
    });
    expect(watched).toEqual([`task:${taskId}`]);
  });

  it("reports a watched task as is", async () => {
    const taskId = "t-liveness-watched";
    const stub = task(taskId);
    const watched: string[] = [];
    await runInDurableObject(stub, (instance) => {
      interceptWatchRun(instance, watched);
    });
    await stub.status();
    await seedRunning(stub, taskId);
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { watchers: number }).watchers = 1;
    });

    expect(await stub.liveness()).toEqual({
      state: "running",
      reattached: false,
    });
    expect(watched).toEqual([]);
  });
});

describe("TaskDO workspace", () => {
  it("gives the task a workspace the model can write and read", async () => {
    let readText = "";
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "write", args: { path: "d.md", content: "草稿" } }] },
        { toolCalls: [{ name: "read", args: { path: "d.md" } }] },
        {
          observe: (context) => {
            readText = lastToolText(context);
          },
          toolCalls: [{ name: "finish_task", args: { summary: "ok" } }],
        },
      ]),
    );
    const taskId = "t-workspace";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
      },
      { timeout: 10_000 },
    );

    expect(readText).toContain("草稿");
  });

  it("clears only the finished task's drafts", async () => {
    await env.ARTIFACTS.put("work/t-other/x.md", "keep me");
    let listText = "";
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "write", args: { path: "d.md", content: "草稿" } }] },
        { toolCalls: [{ name: "list", args: {} }] },
        {
          observe: (context) => {
            listText = lastToolText(context);
          },
          toolCalls: [{ name: "finish_task", args: { summary: "ok" } }],
        },
      ]),
    );
    const taskId = "t-cleanup-done";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
      },
      { timeout: 10_000 },
    );

    // The run really wrote a draft: this cannot pass before the write happened.
    expect(listText).toContain("d.md");

    await vi.waitFor(
      async () => {
        expect(await workspaceKeys(taskId)).toEqual([]);
      },
      { timeout: 10_000 },
    );
    expect(await env.ARTIFACTS.head("work/t-other/x.md")).not.toBeNull();
  });

  it("clears drafts when the task is cancelled", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "write", args: { path: "d.md", content: "草稿" } }] },
        { toolCalls: [{ name: "slow_wait", args: {} }] },
        { text: "should not finish" },
      ]),
    );
    const taskId = "t-cleanup-cancel";
    const stub = task(taskId);
    await installSlowWait(stub);

    await stub.start(spec(taskId));
    await waitForSlowStart(stub);
    expect(await workspaceKeys(taskId)).toEqual([`work/${taskId}/d.md`]);

    const cancelling = stub.cancel();
    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toContain("cancelled");
      },
      { timeout: 5_000 },
    );
    await releaseSlow(stub);
    await expect(cancelling).resolves.toMatchObject({ ok: true });

    await vi.waitFor(
      async () => {
        expect(await workspaceKeys(taskId)).toEqual([]);
      },
      { timeout: 10_000 },
    );
    expect((await stub.status()).state).toBe("cancelled");
  });

  it("clears drafts when the run fails non-retryably", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "write", args: { path: "d.md", content: "草稿" } }] },
        { error: "upstream exploded" },
      ]),
    );
    const taskId = "t-cleanup-fail";
    const stub = task(taskId);

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
      },
      { timeout: 10_000 },
    );

    await vi.waitFor(
      async () => {
        expect(await workspaceKeys(taskId)).toEqual([]);
      },
      { timeout: 10_000 },
    );
    expect((await stub.status()).state).toBe("failed");
  });

  it("keeps drafts after a retryable failure and can still read them on retry", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "write", args: { path: "d.md", content: "草稿" } }] },
        { toolCalls: [{ name: "slow_wait", args: {} }] },
        { text: "after retry" },
      ]),
    );
    const taskId = "t-cleanup-retry";
    const stub = task(taskId);
    await installSlowWait(stub);

    await stub.start(spec(taskId));
    await waitForSlowStart(stub);
    await reportParked(stub);

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events[1]?.payload).toMatchObject({
          type: "failed",
          retryable: true,
        });
      },
      { timeout: 10_000 },
    );

    // A retry resumes the same draft area, so the non-retryable cleanup above
    // must not run for this failure.
    expect(await workspaceKeys(taskId)).toEqual([`work/${taskId}/d.md`]);
    expect(await (await env.ARTIFACTS.get(`work/${taskId}/d.md`))!.text()).toBe(
      "草稿",
    );

    await expect(stub.retryTask()).resolves.toMatchObject({ ok: true });
    expect(await workspaceKeys(taskId)).toEqual([`work/${taskId}/d.md`]);

    await releaseSlow(stub);
    await vi.waitFor(
      async () => {
        expect((await stub.status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );
  });
});

describe("TaskDO artifacts", () => {
  it("records the artifacts saved by this task", async () => {
    await env.ARTIFACTS.put("t-art-ok/file-1/report.md", "# body", {
      httpMetadata: { contentType: "text/markdown" },
    });
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "finish_task",
              args: {
                summary: "done",
                artifacts: [{ key: "t-art-ok/file-1/report.md" }],
              },
            },
          ],
        },
      ]),
    );
    const taskId = "t-art-ok";
    await task(taskId).start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events[1]?.payload).toMatchObject({
          type: "completed",
          artifacts: [{ name: "report.md", key: "t-art-ok/file-1/report.md" }],
        });
      },
      { timeout: 10_000 },
    );
  });

  it("rejects an artifact key from another task and keeps running", async () => {
    await env.ARTIFACTS.put("other-task/file-9/secret.md", "nope");
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "finish_task",
              args: {
                summary: "stolen",
                artifacts: [{ key: "other-task/file-9/secret.md" }],
              },
            },
          ],
        },
        { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
      ]),
    );
    const taskId = "t-art-cross";
    await task(taskId).start(spec(taskId));

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
        expect(events[1]?.payload).toMatchObject({
          type: "completed",
          summary: "ok",
          artifacts: [],
        });
      },
      { timeout: 10_000 },
    );
  });
});

describe("TaskDO skills", () => {
  // The library is shared across tasks and tests, so each case starts empty.
  beforeEach(async () => {
    const page = await env.ARTIFACTS.list({ prefix: "skills/" });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) await env.ARTIFACTS.delete(keys);
  });

  const entry = (name: string, description: string, body = "SECRET_BODY") =>
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

  async function metaOf(taskId: string): Promise<Map<string, string>> {
    return runInDurableObject(task(taskId), (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM meta",
        )
        .toArray();
      return new Map(rows.map((row) => [row.key, row.value]));
    });
  }

  async function seedQueued(
    taskId: string,
    skillsCatalog?: string,
  ): Promise<void> {
    await runInDurableObject(task(taskId), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO meta (key, value) VALUES ('task_id', ?), ('title', ?), ('spec', ?), ('state', 'queued')`,
        taskId,
        `Task ${taskId}`,
        JSON.stringify(spec(taskId)),
      );
      if (skillsCatalog !== undefined) {
        sql.exec(
          "INSERT INTO meta (key, value) VALUES ('skills_catalog', ?)",
          skillsCatalog,
        );
      }
    });
  }

  it("injects metadata before the first request and reads the body only on demand", async () => {
    await env.ARTIFACTS.put(
      "skills/inject/SKILL.md",
      entry("inject", "Discuss ideas"),
    );
    let firstRequest = "";
    let bodyText = "";
    setModelOverride(
      scriptedModel([
        {
          observe: (context) => {
            firstRequest = JSON.stringify(context);
          },
          toolCalls: [
            { name: "read", args: { path: "/skills/inject/SKILL.md" } },
          ],
        },
        {
          observe: (context) => {
            bodyText = lastToolText(context);
          },
          toolCalls: [{ name: "finish_task", args: { summary: "ok" } }],
        },
      ]),
    );
    const taskId = "t-skill-inject";

    await task(taskId).start(spec(taskId));

    await vi.waitFor(
      async () => {
        expect((await task(taskId).status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    expect(firstRequest).toContain("Discuss ideas");
    expect(firstRequest).toContain("/skills/inject/SKILL.md");
    expect(firstRequest).not.toContain("SECRET_BODY");
    expect(bodyText).toContain("SECRET_BODY");
  });

  it("stores the discovered snapshot", async () => {
    await env.ARTIFACTS.put("skills/rescan/SKILL.md", entry("rescan", "Old text"));
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
      ]),
    );
    const taskId = "t-skill-rescan";
    const stub = task(taskId);

    await stub.start(spec(taskId));
    await vi.waitFor(
      async () => {
        expect((await stub.status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    const stored = await metaOf(taskId);
    expect(JSON.parse(stored.get("skills_catalog")!)).toMatchObject({
      skills: [{ name: "rescan", description: "Old text" }],
    });
  });

  it("reuses the stored catalog when a submit has to be retried", async () => {
    await env.ARTIFACTS.put("skills/once/SKILL.md", entry("once", "Old text"));
    const submit = vi
      .spyOn(PiHarness.prototype, "submit")
      .mockRejectedValueOnce(new Error("submit failed"));
    let request = "";
    setModelOverride(
      scriptedModel([
        {
          observe: (context) => {
            request = JSON.stringify(context);
          },
          toolCalls: [{ name: "finish_task", args: { summary: "ok" } }],
        },
      ]),
    );
    const taskId = "t-skill-submit";
    const stub = task(taskId);

    // A failed submit leaves the object queued; the caller reports the failure.
    // Consume the rejection explicitly rather than with `expect().rejects`: the
    // DO RPC wrapper reports an unhandled rejection for a rejected call that
    // `expect` only observes later, which fails the file despite every test
    // passing. `.then(ok, err)` attaches the handler synchronously.
    const failure = await stub.start(spec(taskId)).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure?.message).toBe("submit failed");
    expect((await stub.status()).state).toBe("queued");
    // The library changed after the first scan; a retry must not pick it up.
    await env.ARTIFACTS.put("skills/once/SKILL.md", entry("once", "New text"));
    await env.ARTIFACTS.put("skills/added/SKILL.md", entry("added", "Added later"));

    await stub.start(spec(taskId));

    await vi.waitFor(
      async () => {
        expect((await stub.status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    // pi may submit more than once per run; only that it ran again matters.
    expect(submit.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(request).toContain("Old text");
    expect(request).not.toContain("New text");
    expect(request).not.toContain("Added later");
  });

  it("keeps a cancelled task cancelled when discovery finishes late", async () => {
    await env.ARTIFACTS.put("skills/slow/SKILL.md", entry("slow", "Slow skill"));
    const submit = vi.spyOn(PiHarness.prototype, "submit");
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "never" } }] },
      ]),
    );
    const taskId = "t-skill-cancel";
    const stub = task(taskId);

    let reading: Promise<unknown> | undefined;
    const realArtifacts = env.ARTIFACTS;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowBucket = {
      list: (options?: R2ListOptions) => realArtifacts.list(options),
      get: (key: string) => {
        reading = gate.then(() => realArtifacts.get(key));
        return reading;
      },
    };
    setEnv({ ARTIFACTS: slowBucket });

    const started = stub.start(spec(taskId));
    await vi.waitFor(() => {
      expect(reading).toBeDefined();
    });
    await stub.cancel();
    release();
    await started;

    expect((await stub.status()).state).toBe("cancelled");
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps a stored empty catalog instead of rescanning", async () => {
    await env.ARTIFACTS.put("skills/later/SKILL.md", entry("later", "Added later"));
    let request = "";
    setModelOverride(
      scriptedModel([
        {
          observe: (context) => {
            request = JSON.stringify(context);
          },
          toolCalls: [{ name: "finish_task", args: { summary: "ok" } }],
        },
      ]),
    );
    const taskId = "t-skill-empty";
    await seedQueued(taskId, JSON.stringify({ skills: [], diagnostics: [] }));

    await task(taskId).start(spec(taskId));

    await vi.waitFor(
      async () => {
        expect((await task(taskId).status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    expect(request).not.toContain("Added later");
    expect(request).toContain("/skills/<name>/SKILL.md");
  });

  it("leaves a task from before this feature without a catalog", async () => {
    await env.ARTIFACTS.put("skills/legacy/SKILL.md", entry("legacy", "Legacy lib"));
    let request = "";
    setModelOverride(
      scriptedModel([
        {
          observe: (context) => {
            request = JSON.stringify(context);
          },
          toolCalls: [{ name: "finish_task", args: { summary: "ok" } }],
        },
      ]),
    );
    const taskId = "t-skill-legacy";
    await seedQueued(taskId);

    await task(taskId).start(spec(taskId));

    await vi.waitFor(
      async () => {
        expect((await task(taskId).status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    expect(request).not.toContain("Legacy lib");
    expect(request).not.toContain("/skills/<name>/SKILL.md");
    expect((await metaOf(taskId)).has("skills_catalog")).toBe(false);
  });

  it("uses the frozen description while the entry body stays live", async () => {
    await env.ARTIFACTS.put("skills/frozen/SKILL.md", entry("frozen", "Old text", "OLD_BODY"));
    let request = "";
    let bodyText = "";
    setModelOverride(
      scriptedModel([
        {
          observe: (context) => {
            request = JSON.stringify(context);
          },
          toolCalls: [
            { name: "read", args: { path: "/skills/frozen/SKILL.md" } },
          ],
        },
        {
          observe: (context) => {
            bodyText = lastToolText(context);
          },
          toolCalls: [{ name: "finish_task", args: { summary: "ok" } }],
        },
      ]),
    );
    const taskId = "t-skill-frozen";
    await seedQueued(
      taskId,
      JSON.stringify({
        skills: [
          {
            name: "frozen",
            description: "Frozen text",
            path: "/skills/frozen/SKILL.md",
          },
        ],
        diagnostics: [],
      }),
    );
    await env.ARTIFACTS.put(
      "skills/frozen/SKILL.md",
      entry("frozen", "New text", "NEW_BODY"),
    );

    await task(taskId).start(spec(taskId));

    await vi.waitFor(
      async () => {
        expect((await task(taskId).status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    expect(request).toContain("Frozen text");
    expect(request).not.toContain("New text");
    expect(bodyText).toContain("NEW_BODY");
  });

  it("fails without calling the model when the library cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const submit = vi.spyOn(PiHarness.prototype, "submit");
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "never" } }] },
      ]),
    );
    const broken = {
      list: () => {
        throw new Error("R2 unavailable");
      },
      get: () => {
        throw new Error("R2 unavailable");
      },
    };
    setEnv({ ARTIFACTS: broken });
    const taskId = "t-skill-broken";

    await task(taskId).start(spec(taskId));

    const events = await butler().debugEvents(taskId);
    expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
    expect(events[1]?.payload).toMatchObject({ retryable: false });
    expect(submit).not.toHaveBeenCalled();
    expect(await metaOf(taskId)).toContainEqual(["skills_catalog", "pending"]);
    expect(await task(taskId).status()).toMatchObject({ state: "failed" });
  });

  it("gives bot runs the same catalog", async () => {
    await env.ARTIFACTS.put("skills/forbot/SKILL.md", entry("forbot", "Bot skill"));
    let request = "";
    setModelOverride(
      scriptedModel([
        {
          observe: (context) => {
            request = JSON.stringify(context);
          },
          toolCalls: [{ name: "finish_task", args: { summary: "ok" } }],
        },
      ]),
    );
    const taskId = "t-skill-bot";

    await task(taskId).start({ ...spec(taskId), botId: "b1" });

    await vi.waitFor(
      async () => {
        expect((await task(taskId).status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    expect(request).toContain("Bot skill");
    expect(request).toContain("write_doc");
  });
});
