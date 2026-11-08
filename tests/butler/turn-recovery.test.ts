import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { setClockOverride } from "../../src/butler/notifier";
import { setModelOverride } from "../../src/llm/models";
import type { AdmittedMessage, OutboundMessage } from "../../src/protocol";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

type TurnInternals = {
  checkTurn(): Promise<void>;
  healTurns(): Promise<{ outstanding: number }>;
  turns(): import("../../src/butler/turn-store").TurnStore;
  ensureAgent(): Promise<void>;
  harness: {
    submit(
      input: string,
      options: { operationId: string },
    ): Promise<{ accepted: boolean }>;
    wait(operationId: string): Promise<unknown>;
    pending(): Promise<unknown[]>;
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

async function settled(stub: ReturnType<typeof butler>): Promise<void> {
  await vi.waitFor(
    async () => {
      const pending = await runInDurableObject(stub, (instance) =>
        (
          instance as unknown as {
            harness: { pending(): Promise<unknown[]> };
          }
        ).harness.pending(),
      );
      expect(pending).toEqual([]);
    },
    { timeout: 20_000 },
  );
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

describe("turn recovery", () => {
  it("delivers an answer whose waiter was lost", async () => {
    const stub = butler("turn-takeover");
    const sent = await captureSends(stub);
    setModelOverride(scriptedModel([{ text: "迟到的答案" }]));

    await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as TurnInternals;
      await target.ensureAgent();
      target.turns().insertIfAbsent({
        operationId: "tg:lost",
        submittedAt: now,
      });
      await target.harness.submit("孤儿消息", { operationId: "tg:lost" });
    });

    await settled(stub);
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as TurnInternals).checkTurn();
    });

    expect(sent.map((msg) => msg.text)).toEqual(["迟到的答案"]);
    const rows = await runInDurableObject(stub, (instance) =>
      (instance as unknown as TurnInternals).turns().list(),
    );
    expect(rows).toEqual([]);
  });

  it("reports a turn whose submission is gone", async () => {
    const stub = butler("turn-gone");
    const sent = await captureSends(stub);

    await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as TurnInternals;
      target.turns().insertIfAbsent({
        operationId: "tg:gone",
        submittedAt: now,
      });
      await target.checkTurn();
    });

    expect(sent.map((msg) => msg.text)).toEqual([
      "刚才那条没能答完，再发一次就行",
    ]);
    const rows = await runInDurableObject(stub, (instance) =>
      (instance as unknown as TurnInternals).turns().list(),
    );
    expect(rows).toEqual([]);
  });

  it("does not create a ghost row for a redelivered message", async () => {
    const stub = butler("turn-redelivery");
    const sent = await captureSends(stub);
    setModelOverride(scriptedModel([{ text: "只答一次" }]));

    await stub.handleMessage(message("tg:same"));
    await stub.handleMessage(message("tg:same"));

    expect(sent.map((msg) => msg.text)).toEqual(["收到，正在处理", "只答一次"]);
    const rows = await runInDurableObject(stub, (instance) =>
      (instance as unknown as TurnInternals).turns().list(),
    );
    expect(rows).toEqual([]);
  });

  it("sends one notice when the wait throws", async () => {
    const stub = butler("turn-throws");
    const sent = await captureSends(stub);
    setModelOverride(scriptedModel([{ text: "never used" }]));
    await runInDurableObject(stub, (instance) => {
      const harness = (instance as unknown as TurnInternals).harness;
      harness.wait = async () => {
        throw new Error("boom");
      };
    });

    await stub.handleMessage(message("tg:throws"));
    now += 60_000;
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as TurnInternals).checkTurn();
    });

    expect(sent.map((msg) => msg.text)).toEqual([
      "收到，正在处理",
      "刚才那条没能答完，再发一次就行",
    ]);
    const rows = await runInDurableObject(stub, (instance) =>
      (instance as unknown as TurnInternals).turns().list(),
    );
    expect(rows).toEqual([]);
  });

  it("does not repeat the notice when the abandoned operation is still pending", async () => {
    const stub = butler("turn-throws-pending");
    const sent = await captureSends(stub);
    setModelOverride(scriptedModel([{ text: "never used" }]));
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as TurnInternals;
      target.harness.wait = async () => {
        throw new Error("boom");
      };
      target.harness.pending = async () => [
        { operationId: "tg:throws-pending", session: "1", status: "running" },
      ];
    });

    await stub.handleMessage(message("tg:throws-pending"));
    expect(sent.map((msg) => msg.text)).toEqual([
      "收到，正在处理",
      "刚才那条没能答完，再发一次就行",
    ]);

    // The operation never leaves `pending()`; without a tombstone the rebuild
    // loop re-announces it.
    for (const step of [6, 6]) {
      now += step * 60_000;
      await runInDurableObject(stub, async (instance) => {
        await (instance as unknown as TurnInternals).checkTurn();
      });
    }
    expect(sent.map((msg) => msg.text)).toEqual([
      "收到，正在处理",
      "刚才那条没能答完，再发一次就行",
    ]);
  });

  it("reports the outstanding count and arms a check", async () => {
    const stub = butler("turn-heal");
    await captureSends(stub);

    const healed = await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as TurnInternals;
      target.turns().insertIfAbsent({
        operationId: "tg:pending",
        submittedAt: now,
      });
      // A running turn is not delivered by the sweep; it only arms the check.
      target.harness.pending = async () => [
        { operationId: "tg:pending", session: "1", status: "running" },
      ];
      return await target.healTurns();
    });

    expect(healed).toEqual({ outstanding: 1 });
    const armed = await runInDurableObject(stub, async (instance) => {
      const schedules = await (
        instance as unknown as {
          listSchedules(): Promise<{ callback: string }[]>;
        }
      ).listSchedules();
      return schedules.filter((entry) => entry.callback === "checkTurn").length;
    });
    expect(armed).toBe(1);
  });
});
