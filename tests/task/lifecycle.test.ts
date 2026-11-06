import { PiHarness, PiSession } from "agents/harness/pi";
import { Type, type ToolResultMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
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

async function workspaceKeys(taskId: string): Promise<string[]> {
  const page = await env.ARTIFACTS.list({ prefix: `work/${taskId}/` });
  return page.objects.map((object) => object.key);
}

describe("TaskDO lifecycle", () => {
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
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "write", args: { path: "d.md", content: "草稿" } }] },
        { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
      ]),
    );
    const taskId = "t-cleanup-done";
    const stub = task(taskId);

    await stub.start(spec(taskId));

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

  it("keeps drafts when the run fails", async () => {
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

    expect(await workspaceKeys(taskId)).toEqual([`work/${taskId}/d.md`]);
    expect(await (await env.ARTIFACTS.get(`work/${taskId}/d.md`))!.text()).toBe(
      "草稿",
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
