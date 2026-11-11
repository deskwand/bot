import { env, runInDurableObject } from "cloudflare:test";
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { PiHarness, PiOperationResult } from "agents/harness/pi";
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

type Admission = { current: boolean };

type TurnInternals = {
  turns(): import("../../src/butler/turn-store").TurnStore;
  deliverResult(
    operationId: string,
    result: PiOperationResult,
  ): Promise<void>;
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

/** A promise the scripted model awaits before answering. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Captures what the Butler sends. */
async function captureSends(
  stub: ReturnType<typeof butler>,
  admission: Admission = { current: true },
): Promise<OutboundMessage[]> {
  const sent: OutboundMessage[] = [];
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { channels(): unknown }).channels = () => ({
      currentRoute: async () => ({ channel: "telegram", routeKey: "test" }),
      isAdmissionCurrent: async () => admission.current,
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

async function runningIds(stub: ReturnType<typeof butler>): Promise<string[]> {
  const pending = await runInDurableObject(stub, (instance) =>
    (instance as unknown as { harness: PiHarness }).harness.pending(),
  );
  return pending
    .filter((operation) => operation.status === "running")
    .map((operation) => operation.operationId);
}

/** The abort waits for the gated model call, so supersede first. */
async function waitSuperseded(stub: ReturnType<typeof butler>): Promise<void> {
  await vi.waitFor(async () => {
    const rows = await turnRows(stub);
    expect(rows.some((row) => row.supersededAt !== null)).toBe(true);
  });
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

describe("supersede a thinking turn", () => {
  it("restarts a thinking turn with the new message", async () => {
    const stub = butler("supersede-restart");
    const sent = await captureSends(stub);
    const held = gate();
    let seen = "";
    setModelOverride(
      scriptedModel([
        { text: "半句话的答案", gate: held.wait },
        {
          text: "完整答案",
          observe: (context) => {
            seen = context.messages.map((msg) => JSON.stringify(msg)).join("\n");
          },
        },
      ]),
    );

    const first = stub.handleMessage(message("tg:one", "明天"));
    await vi.waitFor(async () =>
      expect(await runningIds(stub)).toContain("tg:one"),
    );
    const second = stub.handleMessage(message("tg:two", "上午提醒我开会"));
    await waitSuperseded(stub);
    held.open();
    await Promise.all([first, second]);

    const texts = sent.map((msg) => msg.text);
    expect(texts).not.toContain("半句话的答案");
    expect(texts).not.toContain("刚才那条没能答完，再发一次就行");
    expect(texts.filter((text) => text === "完整答案")).toHaveLength(1);
    expect(seen).toContain("明天");
    expect(seen).toContain("上午提醒我开会");
    expect(await turnRows(stub)).toEqual([]);
  });

  it("does not interrupt a turn that already used a tool", async () => {
    const stub = butler("supersede-tool");
    const sent = await captureSends(stub);
    await installSlowWait(stub);
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "slow_wait", args: {} }] },
        { text: "第一条答案" },
        { text: "第二条答案" },
      ]),
    );

    const first = stub.handleMessage(message("tg:one", "一"));
    await vi.waitFor(async () => expect(await slowStarted(stub)).toBe(true));
    const second = stub.handleMessage(message("tg:two", "二"));
    await vi.waitFor(async () => {
      const ids = (await turnRows(stub)).map((row) => row.operationId);
      expect(ids).toEqual(expect.arrayContaining(["tg:one", "tg:two"]));
    });
    await releaseSlow(stub);
    await Promise.all([first, second]);

    const texts = sent.map((msg) => msg.text);
    expect(texts.filter((text) => text === "第一条答案")).toHaveLength(1);
    expect(texts.filter((text) => text === "第二条答案")).toHaveLength(1);
  });

  it("acknowledges both the replaced message and its replacement", async () => {
    const stub = butler("supersede-receipt");
    const sent = await captureSends(stub);
    const held = gate();
    setModelOverride(
      scriptedModel([
        { text: "半句话的答案", gate: held.wait },
        { text: "完整答案" },
      ]),
    );

    const first = stub.handleMessage(message("tg:one", "一"));
    await vi.waitFor(() =>
      expect(sent.filter((msg) => msg.text === "收到，正在处理")).toHaveLength(1),
    );
    const second = stub.handleMessage(message("tg:two", "二"));
    await waitSuperseded(stub);
    held.open();
    await Promise.all([first, second]);

    expect(sent.filter((msg) => msg.text === "收到，正在处理")).toHaveLength(2);
    expect(sent.map((msg) => msg.text)).toContain("完整答案");
  });

  it("still delivers a done result for a superseded turn", async () => {
    const stub = butler("supersede-settled");
    const sent = await captureSends(stub);
    setModelOverride(scriptedModel([{ text: "已答完" }]));
    await stub.handleMessage(message("tg:one", "一"));

    await runInDurableObject(stub, async (instance) => {
      const internals = instance as unknown as TurnInternals;
      internals.turns().insertIfAbsent({
        operationId: "tg:one-late",
        submittedAt: now,
      });
      internals.turns().supersede("tg:one-late", now);
      await internals.deliverResult("tg:one-late", {
        operationId: "tg:one-late",
        session: "1",
        status: "done",
        text: "照发",
      });
    });

    expect(sent.map((msg) => msg.text)).toContain("照发");
  });

  it("does not supersede a turn on its own redelivery", async () => {
    const stub = butler("supersede-redelivery");
    const sent = await captureSends(stub);
    const held = gate();
    setModelOverride(
      scriptedModel([
        { text: "半句话的答案", gate: held.wait },
        { text: "不该出现" },
      ]),
    );

    const first = stub.handleMessage(message("tg:one", "一"));
    await vi.waitFor(async () =>
      expect(await runningIds(stub)).toContain("tg:one"),
    );
    const again = stub.handleMessage(message("tg:one", "一"));
    held.open();
    await Promise.all([first, again]);

    const texts = sent.map((msg) => msg.text);
    expect(texts.filter((text) => text === "半句话的答案")).toHaveLength(1);
    expect(texts).not.toContain("不该出现");
  });

  it("does not supersede on a late redelivery of an answered message", async () => {
    const stub = butler("supersede-late-redelivery");
    const sent = await captureSends(stub);
    const held = gate();
    setModelOverride(
      scriptedModel([
        { text: "旧答案" },
        { text: "新答案", gate: held.wait },
        { text: "不该出现" },
      ]),
    );

    await stub.handleMessage(message("tg:old", "旧"));
    const current = stub.handleMessage(message("tg:new", "新"));
    await vi.waitFor(async () =>
      expect(await runningIds(stub)).toContain("tg:new"),
    );
    const again = stub.handleMessage(message("tg:old", "旧"));
    // Give the redelivery time to reach the supersede check.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const marked = (await turnRows(stub)).find(
      (row) => row.operationId === "tg:new",
    )?.supersededAt;
    held.open();
    await Promise.all([current, again]);

    expect(marked).toBeNull();
    const texts = sent.map((msg) => msg.text);
    expect(texts.filter((text) => text === "旧答案")).toHaveLength(1);
    expect(texts.filter((text) => text === "新答案")).toHaveLength(1);
  });

  it("does not supersede when the new message is blocked", async () => {
    const stub = butler("supersede-blocked");
    const admission: Admission = { current: true };
    const sent = await captureSends(stub, admission);
    const held = gate();
    setModelOverride(
      scriptedModel([
        { text: "半句话的答案", gate: held.wait },
        { text: "不该出现" },
      ]),
    );

    const first = stub.handleMessage(message("tg:one", "一"));
    await vi.waitFor(async () =>
      expect(await runningIds(stub)).toContain("tg:one"),
    );
    admission.current = false;
    const second = stub.handleMessage(message("tg:two", "二"));
    held.open();
    await Promise.all([first, second]);

    expect(sent.map((msg) => msg.text)).toContain("半句话的答案");
  });

  it("does not queue a task report behind the owner's turn", async () => {
    const stub = butler("supersede-queued-report");
    const sent = await captureSends(stub);
    await seedTask(stub);
    // The speaker is one-shot; keep it out of the scripted harness turns.
    await runInDurableObject(stub, (instance) => {
      (
        instance as unknown as { completeSpeak: () => Promise<string> }
      ).completeSpeak = async () => "S";
    });
    const held = gate();
    setModelOverride(
      scriptedModel([
        { text: "第一条答案", gate: held.wait },
        { text: "新的回答" },
      ]),
    );

    const first = stub.handleMessage(message("tg:one", "一"));
    await vi.waitFor(async () =>
      expect(await runningIds(stub)).toContain("tg:one"),
    );
    const report = stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "S",
      artifacts: [],
    });
    await vi.waitFor(async () => {
      const pending = await runInDurableObject(stub, (instance) =>
        (instance as unknown as { harness: PiHarness }).harness.pending(),
      );
      expect(pending.map((operation) => operation.operationId)).not.toContain(
        "task-completed:t1",
      );
    });
    const second = stub.handleMessage(message("tg:two", "二"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const marked = (await turnRows(stub)).find(
      (row) => row.operationId === "tg:one",
    )?.supersededAt;
    held.open();
    await Promise.all([first, report, second]);

    // The report is no longer a queued turn, so it cannot shield the owner's
    // in-flight thought from the new message.
    expect(marked).not.toBeNull();
    const texts = sent.map((msg) => msg.text ?? "");
    expect(texts).not.toContain("第一条答案");
    expect(texts).toContain("新的回答");
    expect(texts.filter((text) => text === "S")).toHaveLength(1);
  });

  it("delivers a task report without starting a butler turn", async () => {
    const stub = butler("supersede-report");
    const sent = await captureSends(stub);
    await seedTask(stub);
    await runInDurableObject(stub, (instance) => {
      (
        instance as unknown as { completeSpeak: () => Promise<string> }
      ).completeSpeak = async () => "S";
    });
    let modelCalls = 0;
    setModelOverride(
      scriptedModel([
        {
          text: "must not run",
          observe: () => {
            modelCalls += 1;
          },
        },
      ]),
    );

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "S",
      artifacts: [],
    });

    expect(modelCalls).toBe(0);
    expect(await turnRows(stub)).toEqual([]);
    expect(sent.map((msg) => msg.text)).toContain("S");
  });
});
