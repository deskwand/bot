import { env, runInDurableObject } from "cloudflare:test";
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import { TURN_PARKED_GRACE_MS } from "../../src/butler/turn";
import { setModelOverride } from "../../src/llm/models";
import { setChannelOverride } from "../../src/channels/override";
import type { AdmittedMessage, OutboundMessage } from "../../src/protocol";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

type SlowControl = { started: boolean; released: boolean };

type HoldControl = { started: boolean; released: boolean };

type TurnInternals = {
  checkTurn(): Promise<void>;
  turns(): import("../../src/butler/turn-store").TurnStore;
  lease: { acquire(op: "export", opId: string): unknown };
  harness: {
    pending(): Promise<unknown[]>;
    retry(): Promise<boolean>;
    abort(options?: { operationId?: string }): Promise<boolean>;
  };
};

const START = Date.UTC(2030, 0, 1, 9, 0, 0);
let now = START;

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function message(eventId: string): AdmittedMessage {
  return {
    type: "message",
    channel: "telegram",
    chatId: "42",
    userId: "1",
    text: "查一下",
    eventId,
    routeKey: "test",
  };
}

/** Captures what the Butler sends, including the priority. */
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

/** Blocks the turn after the ack retry, so the test can inspect the ledger. */
async function installHold(stub: ReturnType<typeof butler>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const control: HoldControl = { started: false, released: false };
    (instance as { holdControl?: HoldControl }).holdControl = control;
    const tool: ToolRegistration<typeof SlowWait> = {
      name: "hold_after_ack",
      description: "Hold the turn until the test releases it.",
      parameters: SlowWait,
      async execute() {
        control.started = true;
        while (!control.released) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return { output: [{ type: "text", text: "released" }] };
      },
    };
    instance.registry.install({ name: "test-hold", tools: [tool] });
  });
}

async function holdStarted(stub: ReturnType<typeof butler>): Promise<boolean> {
  return runInDurableObject(
    stub,
    (instance) =>
      (instance as { holdControl?: HoldControl }).holdControl?.started ?? false,
  );
}

async function releaseHold(stub: ReturnType<typeof butler>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const control = (instance as { holdControl?: HoldControl }).holdControl;
    if (control) control.released = true;
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

describe("turn alerts", () => {
  it("acknowledges as soon as the message is accepted", async () => {
    const stub = butler("turn-ack");
    const sent = await captureSends(stub);
    let openModel = () => {};
    const modelGate = new Promise<void>((resolve) => {
      openModel = resolve;
    });
    setModelOverride(scriptedModel([{ text: "查完了", gate: modelGate }]));

    const running = stub.handleMessage(message("tg:ack"));
    // The receipt does not wait for the model: it is out while the model is
    // still held at its gate.
    await vi.waitFor(() =>
      expect(sent.map((msg) => msg.text)).toEqual(["收到，正在处理"]),
    );
    expect(sent[0]?.priority).toBe("normal");
    const waiting = await runInDurableObject(stub, (instance) =>
      (instance as unknown as TurnInternals).turns().get("tg:ack"),
    );
    expect(waiting?.ackAt).not.toBeNull();

    openModel();
    await running;
    expect(sent.map((msg) => msg.text)).toEqual(["收到，正在处理", "查完了"]);
    expect(sent[1]?.priority).toBe("critical");
  });

  it("acknowledges once for a message across a tool loop", async () => {
    const stub = butler("turn-ack-loop");
    const sent = await captureSends(stub);
    await installSlowWait(stub);
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "slow_wait", args: {} }] },
        { text: "查完了" },
      ]),
    );

    const running = stub.handleMessage(message("tg:loop"));
    await vi.waitFor(async () => expect(await slowStarted(stub)).toBe(true));
    await releaseSlow(stub);
    await running;

    expect(sent.filter((msg) => msg.text === "收到，正在处理")).toHaveLength(1);
    expect(sent.map((msg) => msg.text)).toEqual(["收到，正在处理", "查完了"]);
  });

  it("acknowledges each message while the previous turn still runs", async () => {
    const stub = butler("turn-follow-up");
    const sent = await captureSends(stub);
    await installSlowWait(stub);
    await installHold(stub);
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "slow_wait", args: {} }] },
        { text: "第一条答案" },
        { toolCalls: [{ name: "hold_after_ack", args: {} }] },
        { text: "第二条答案" },
      ]),
    );

    const first = stub.handleMessage(message("tg:one"));
    await vi.waitFor(async () => expect(await slowStarted(stub)).toBe(true));
    const second = stub.handleMessage(message("tg:two"));
    // Each accepted message says so at once, before either answer.
    await vi.waitFor(() =>
      expect(sent.map((msg) => msg.text)).toEqual([
        "收到，正在处理",
        "收到，正在处理",
      ]),
    );

    await releaseSlow(stub);
    await vi.waitFor(async () => expect(await holdStarted(stub)).toBe(true));
    await vi.waitFor(() =>
      expect(sent.map((msg) => msg.text)).toEqual([
        "收到，正在处理",
        "收到，正在处理",
        "第一条答案",
      ]),
    );

    await releaseHold(stub);
    await first;
    await second;
    expect(sent.map((msg) => msg.text)).toEqual([
      "收到，正在处理",
      "收到，正在处理",
      "第一条答案",
      "第二条答案",
    ]);
  });

  it("does not retry a failed receipt", async () => {
    const stub = butler("turn-ack-fail");
    const sent: OutboundMessage[] = [];
    let ackAttempts = 0;
    let openModel = () => {};
    const modelGate = new Promise<void>((resolve) => {
      openModel = resolve;
    });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { channels(): unknown }).channels = () => ({
        currentRoute: async () => ({ channel: "telegram", routeKey: "test" }),
        isAdmissionCurrent: async () => true,
        editCurrent: async () => true,
        sendCurrent: async (msg: OutboundMessage) => {
          if (msg.text === "收到，正在处理") {
            ackAttempts += 1;
            return null;
          }
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
    setModelOverride(scriptedModel([{ text: "查完了", gate: modelGate }]));

    const running = stub.handleMessage(message("tg:ack-fail"));
    await vi.waitFor(() => expect(ackAttempts).toBe(1));
    await vi.waitFor(async () => {
      const row = await runInDurableObject(stub, (instance) =>
        (instance as unknown as TurnInternals).turns().get("tg:ack-fail"),
      );
      expect(row).toBeDefined();
    });
    // One attempt, no retry: the failed receipt leaves the ledger untouched.
    const waiting = await runInDurableObject(stub, (instance) =>
      (instance as unknown as TurnInternals).turns().get("tg:ack-fail"),
    );
    expect(waiting?.ackAt).toBeNull();

    openModel();
    await running;
    expect(ackAttempts).toBe(1);
    expect(sent.map((msg) => msg.text)).toEqual(["查完了"]);
  });

  it("stays silent and keeps the ledger untouched while the lease is held", async () => {
    const stub = butler("turn-lease");
    const sent = await captureSends(stub);
    const before = await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as TurnInternals;
      target.lease.acquire("export", "test");
      target.turns().insertIfAbsent({
        operationId: "tg:lease",
        submittedAt: now,
      });
      await target.checkTurn();
      return target.turns().get("tg:lease");
    });

    expect(sent).toEqual([]);
    expect(before).toMatchObject({ ackAt: null, signature: null });
  });

  it("retries a parked turn once before reporting it", async () => {
    const stub = butler("turn-parked");
    await captureSends(stub);
    const retries = await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as TurnInternals;
      target.turns().insertIfAbsent({
        operationId: "tg:parked",
        submittedAt: now,
      });
      let calls = 0;
      target.harness.pending = async () => [
        { operationId: "tg:parked", session: "1", status: "parked" },
      ];
      target.harness.retry = async () => {
        calls += 1;
        return true;
      };
      await target.checkTurn();
      await target.checkTurn();
      return calls;
    });

    expect(retries).toBe(1);
  });

  it("withdraws a parked turn that retry did not revive", async () => {
    const stub = butler("turn-parked-giveup");
    const sent = await captureSends(stub);
    const aborts = await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as TurnInternals;
      target.turns().insertIfAbsent({
        operationId: "tg:parked2",
        submittedAt: now,
      });
      let calls = 0;
      target.harness.pending = async () => [
        { operationId: "tg:parked2", session: "1", status: "parked" },
      ];
      target.harness.retry = async () => true;
      target.harness.abort = async () => {
        calls += 1;
        return true;
      };
      await target.checkTurn();
      now += TURN_PARKED_GRACE_MS + 1;
      await target.checkTurn();
      return calls;
    });

    expect(aborts).toBe(1);
    expect(sent.map((msg) => msg.text)).toEqual([
      "刚才那条没能答完，再发一次就行",
    ]);
  });
});
