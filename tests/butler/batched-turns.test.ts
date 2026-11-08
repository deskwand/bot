import { env, runInDurableObject } from "cloudflare:test";
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import type { AdmittedMessage, OutboundMessage } from "../../src/protocol";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

type SlowControl = { started: boolean; released: boolean };

type TurnInternals = {
  turns(): import("../../src/butler/turn-store").TurnStore;
};

const START = Date.UTC(2030, 0, 1, 9, 0, 0);
let now = START;

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function message(eventId: string, text: string): AdmittedMessage {
  return {
    type: "message",
    channel: "telegram",
    chatId: "42",
    userId: "1",
    text,
    eventId,
    routeKey: "test",
  };
}

/** Captures what the Butler sends. */
async function captureSends(
  stub: ReturnType<typeof butler>,
): Promise<OutboundMessage[]> {
  const sent: OutboundMessage[] = [];
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { channels(): unknown }).channels = () => ({
      currentRoute: async () => ({ channel: "telegram", routeKey: "test" }),
      isAdmissionCurrent: async () => true,
      editCurrent: async () => true,
      sendCurrent: async (msg: OutboundMessage) => {
        sent.push(msg);
        return {
          channel: "telegram",
          conversationId: "42",
          routeKey: "test",
          messageId: String(sent.length),
        };
      },
    });
  });
  return sent;
}

const SlowWait = Type.Object({});

/** A tool that keeps the Butler's turn running until the test releases it. */
async function installSlowWait(stub: ReturnType<typeof butler>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const control: SlowControl = { started: false, released: false };
    (instance as { slowControl?: SlowControl }).slowControl = control;
    const tool: ToolRegistration<typeof SlowWait> = {
      name: "slow_wait",
      description: "Wait until the test releases the turn.",
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

async function slowStarted(stub: ReturnType<typeof butler>): Promise<boolean> {
  return runInDurableObject(
    stub,
    (instance) =>
      (instance as { slowControl?: SlowControl }).slowControl?.started ?? false,
  );
}

async function releaseSlow(stub: ReturnType<typeof butler>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const control = (instance as { slowControl?: SlowControl }).slowControl;
    if (control) control.released = true;
  });
}

async function turnRows(stub: ReturnType<typeof butler>) {
  return runInDurableObject(stub, (instance) =>
    (instance as unknown as TurnInternals).turns().list(),
  );
}

async function pendingIds(stub: ReturnType<typeof butler>): Promise<string[]> {
  const pending = await runInDurableObject(stub, (instance) =>
    (
      instance as unknown as {
        harness: { pending(): Promise<{ operationId: string }[]> };
      }
    ).harness.pending(),
  );
  return pending.map((operation) => operation.operationId);
}

async function seedTask(stub: ReturnType<typeof butler>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO tasks (id, title, status, created_at, updated_at, chat_id, artifacts_json)
       VALUES ('t1', '查天气', 'queued', 0, 0, '42', '[]')`,
    );
  });
}

beforeEach(async () => {
  now = START;
  setClockOverride({
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  await seedOwnerAddress("42");
});

afterEach(() => {
  setClockOverride(null);
  setModelOverride(null);
  setChannelOverride("telegram", null);
  vi.restoreAllMocks();
});

describe("batched turns", () => {
  it("merges queued messages into one answer", async () => {
    const stub = butler("batched-merge");
    const sent = await captureSends(stub);
    await installSlowWait(stub);
    let seen = "";
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "slow_wait", args: {} }] },
        { text: "第一条答案" },
        {
          text: "合并答案",
          observe: (context) => {
            seen = context.messages.map((msg) => JSON.stringify(msg)).join("\n");
          },
        },
      ]),
    );

    const first = stub.handleMessage(message("tg:one", "一"));
    await vi.waitFor(async () => expect(await slowStarted(stub)).toBe(true));
    const queued = [
      stub.handleMessage(message("tg:two", "二")),
      stub.handleMessage(message("tg:three", "三")),
      stub.handleMessage(message("tg:four", "四")),
    ];
    // Rows appear once pi admitted the submit, so all three are in the inbox
    // before the running turn ends.
    await vi.waitFor(async () => {
      const ids = (await turnRows(stub)).map((row) => row.operationId);
      expect(ids).toHaveLength(4);
      expect(ids).toEqual(
        expect.arrayContaining(["tg:one", "tg:two", "tg:three", "tg:four"]),
      );
    });
    await releaseSlow(stub);
    await Promise.all([first, ...queued]);

    const texts = sent.map((msg) => msg.text);
    expect(texts.filter((text) => text === "第一条答案")).toHaveLength(1);
    expect(texts.filter((text) => text === "合并答案")).toHaveLength(1);
    // Each accepted message says it arrived, even though one run answers them.
    expect(texts.filter((text) => text === "收到，正在处理")).toHaveLength(4);
    for (const text of ["二", "三", "四"]) expect(seen).toContain(text);
    expect(await turnRows(stub)).toEqual([]);
  });

  it("still delivers the answer when its answer id cannot be read", async () => {
    const stub = butler("batched-lookup-fails");
    const sent = await captureSends(stub);
    setModelOverride(scriptedModel([{ text: "照样送达" }]));
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { harness: { storage(): Promise<never> } })
        .harness.storage = async () => {
        throw new Error("storage unavailable");
      };
    });

    await stub.handleMessage(message("tg:lookup", "一"));

    expect(sent.map((msg) => msg.text)).toContain("照样送达");
    expect(sent.map((msg) => msg.text)).not.toContain("刚才那条没能答完，再发一次就行");
  });

  it("runs queued input after a failed turn", async () => {
    const stub = butler("batched-after-fail");
    const sent = await captureSends(stub);
    await installSlowWait(stub);
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "slow_wait", args: {} }] },
        { error: "upstream exploded" },
        { text: "后续答案" },
      ]),
    );

    const first = stub.handleMessage(message("tg:one", "一"));
    await vi.waitFor(async () => expect(await slowStarted(stub)).toBe(true));
    const second = stub.handleMessage(message("tg:two", "二"));
    await vi.waitFor(async () => {
      const ids = (await turnRows(stub)).map((row) => row.operationId);
      expect(ids).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining(["tg:one", "tg:two"]));
    });
    await releaseSlow(stub);
    await first;
    await second;

    expect(sent.map((msg) => msg.text)).toContain("后续答案");
  });

  it("sends a task report's text once when it shares a turn with the owner", async () => {
    const stub = butler("batched-report");
    const sent = await captureSends(stub);
    await installSlowWait(stub);
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "slow_wait", args: {} }] },
        { text: "第一条答案" },
        { text: "合并答案" },
      ]),
    );

    const first = stub.handleMessage(message("tg:one", "一"));
    await vi.waitFor(async () => expect(await slowStarted(stub)).toBe(true));
    await seedTask(stub);
    const report = stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "S",
      artifacts: [],
    });
    const second = stub.handleMessage(message("tg:two", "二"));
    await vi.waitFor(async () => {
      const pending = await pendingIds(stub);
      expect(pending).toContain("task-completed:t1");
      expect(pending).toContain("tg:two");
    });
    await releaseSlow(stub);
    await first;
    await report;
    await second;

    // The report may wrap the answer in its completion copy.
    expect(sent.filter((msg) => msg.text?.includes("合并答案"))).toHaveLength(1);
  });
});
