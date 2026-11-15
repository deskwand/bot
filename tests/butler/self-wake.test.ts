import { env, runInDurableObject } from "cloudflare:test";
import { Type } from "typebox";
import { describe, it, expect, vi } from "vitest";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  SelfWakeStore,
  isSelfWake,
  guardSelfTool,
} from "../../src/butler/self-wake";
import { createSelfWakeTools } from "../../src/butler/self-tools";
const START = Date.UTC(2030, 0, 1, 23, 59);
const stub = (n: string) =>
  env.BUTLER.get(env.BUTLER.idFromName(`self-wake-${n}`));
describe("self wake storage", () => {
  it("preserves intent and backoff across reconstruction; stale generations cannot change it", () =>
    runInDurableObject(stub("store"), (_i, state) => {
      let s = new SelfWakeStore(state.storage.sql);
      expect(s.get().at).toBeNull();
      const first = s.set(START, START);
      s.deferIfGeneration(first.generation, START + 60000);
      s = new SelfWakeStore(state.storage.sql);
      expect(s.get().retryAt).toBe(START + 60000);
      expect(s.reserve(first.generation, START)).toBe(false);
      expect(s.rearmInterrupted(first.generation, START + 60000)).toBe(true);
      expect(s.rearmInterrupted(first.generation, START + 60000)).toBe(false);
      const next = s.set(START + 300000, START);
      s.clearIfGeneration(first.generation);
      expect(s.get().at).toBe(next.at);
      const cancel = s.set(null, START);
      expect(cancel.retryAt).toBeNull();
      expect(cancel.generation).toBe(next.generation + 1);
      expect(s.rearmInterrupted(cancel.generation, START + 60000)).toBe(false);
    }));
  it("caps UTC daily reservations and refunds only the reservation day", () =>
    runInDurableObject(stub("quota"), (_i, state) => {
      const s = new SelfWakeStore(state.storage.sql);
      const v = s.set(START, START);
      for (let i = 0; i < 48; i++)
        expect(s.reserve(v.generation, START)).toBe(true);
      expect(s.reserve(v.generation, START)).toBe(false);
      s.refund("2030-01-01");
      expect(s.get().reserved).toBe(47);
      expect(s.reserve(v.generation, START + 60000)).toBe(true);
      expect(s.get()).toMatchObject({ day: "2030-01-02", reserved: 1 });
      s.refund("2030-01-01");
      expect(s.get().reserved).toBe(1);
      expect(s.reserve(v.generation + 1, START + 60000)).toBe(false);
    }));
});
describe("host capability guard", () => {
  it("fails closed and preserves owner tool invocation receiver and metadata", async () => {
    let mode = true;
    const execute = vi.fn(async function (this: unknown, ...args: unknown[]) {
      return {
        output: [
          { type: "text" as const, text: this === tool ? "original" : "wrong" },
        ],
      };
    });
    const tool: ToolRegistration = {
      name: "spawn_task",
      description: "test",
      parameters: Type.Object({}),
      execute,
    };
    const wrapped = guardSelfTool(tool, async () => mode, "en");
    expect(
      (await wrapped.execute({} as never, {} as never, {} as never)).isError,
    ).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    mode = false;
    expect(
      (await wrapped.execute({} as never, {} as never, {} as never)).output,
    ).toEqual([{ type: "text", text: "original" }]);
    const broken = guardSelfTool(
      tool,
      async () => {
        throw new Error("storage");
      },
      "en",
    );
    expect(
      (await broken.execute({} as never, {} as never, {} as never)).isError,
    ).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  for (const name of [
    "read_self",
    "write_self",
    "record_experience",
    "now",
    "quick_lookup",
    "list_tasks",
    "get_task",
    "list_schedules",
    "set_self_wake",
    "notify_owner",
  ])
    it(`permits ${name} only as listed`, async () => {
      const tool: ToolRegistration = {
        name,
        description: "test",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => ({ output: [{ type: "text", text: "allowed" }] }),
      };
      const out = await guardSelfTool(tool, async () => true, "en").execute(
        {} as never,
        {} as never,
        {} as never,
      );
      expect(out.output).toEqual([{ type: "text", text: "allowed" }]);
    });
  it("classifies only the host namespace", () => {
    expect(isSelfWake("self-wake:1")).toBe(true);
    expect(isSelfWake("tg:1")).toBe(false);
  });
});
describe("self wake tools", () => {
  it("validates UTC ISO bounds, supports cancellation, and reports failed notifications", async () => {
    const setWake = vi.fn(async (at: number | null) => ({
      generation: 1,
      at,
      retryAt: null,
      day: "",
      reserved: 0,
    }));
    const tools = createSelfWakeTools({
      locale: "en",
      now: () => START,
      setWake,
      notify: async () => false,
    });
    const set = tools[0]!;
    const call = (at: string | null) =>
      set.execute({ at } as never, {} as never, {} as never);
    for (const delta of [300000, 30 * 86400000])
      expect(
        (await call(new Date(START + delta).toISOString())).isError,
      ).not.toBe(true);
    for (const at of [
      new Date(START + 299999).toISOString(),
      new Date(START + 30 * 86400000 + 1).toISOString(),
      "2030-01-02T00:05:00",
      "not date",
      "2030-02-30T00:00:00Z",
    ])
      expect((await call(at)).isError).toBe(true);
    expect((await call(null)).isError).not.toBe(true);
    expect(setWake).toHaveBeenLastCalledWith(null);
    expect(
      (
        await tools[1]!.execute(
          { text: "hello" } as never,
          {} as never,
          {} as never,
        )
      ).isError,
    ).toBe(true);
  });
});

import { afterEach, beforeEach } from "vitest";
import type { PiHarness, PiOperationResult } from "agents/harness/pi";
import { ConversationBusy } from "@earendil-works/pi-durable";
import { setClockOverride } from "../../src/butler/notifier";
import { setModelOverride } from "../../src/llm/models";
import { scriptedModel } from "../helpers/scripted-model";
import type { OutboundMessage } from "../../src/protocol";
import type { ButlerDO } from "../../src/butler/butler-do";
import { TurnStore } from "../../src/butler/turn-store";
import { MaintenanceStore } from "../../src/admin/maintenance";

type Internals = {
  sweepTurns(now: number): Promise<number | null>;
  ensureAgent(): Promise<void>;
  armSelfWake(): Promise<void>;
  setSelfWake(
    at: number | null,
  ): Promise<import("../../src/butler/self-wake").SelfWakeState>;
  deliverResult(id: string, result: PiOperationResult): Promise<void>;
  answerIdOf(id: string): Promise<string | undefined>;
  channels(): unknown;
};
let clock = START;
beforeEach(() => {
  clock = START;
  setClockOverride({
    now: () => clock,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
});
afterEach(() => {
  setClockOverride(null);
  setModelOverride(null);
  vi.restoreAllMocks();
});
async function prepare(name: string) {
  const target = stub(name);
  const sent: OutboundMessage[] = [];
  await runInDurableObject(target, (i) => {
    (i as unknown as Internals).channels = () => ({
      currentRoute: async () => ({ channel: "telegram", routeKey: "test" }),
      isAdmissionCurrent: async () => true,
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
  const intent = await runInDurableObject(target, (_i, s) =>
    new SelfWakeStore(s.storage.sql).set(clock, clock),
  );
  return { target, sent, generation: intent.generation };
}
const stateOf = (target: ReturnType<typeof stub>) =>
  runInDurableObject(target, (_i, s) => new SelfWakeStore(s.storage.sql).get());
const wake = (target: ReturnType<typeof stub>, generation: number) =>
  target.wakeSelf({ generation });
const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};
describe("silent self wake integration", () => {
  it("runs the real butler with current identity, persists growth and sends only explicit notifications", async () => {
    let context = "";
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "write_self",
              args: {
                kind: "situation",
                content: "waiting carefully",
                expectedVersion: 0,
              },
            },
          ],
          observe: (c) => (context = JSON.stringify(c.messages)),
        },
        {
          toolCalls: [
            { name: "notify_owner", args: { text: "worth sharing" } },
          ],
        },
        { text: "internal only" },
      ]),
    );
    const { target, sent, generation } = await prepare("run");
    await runInDurableObject(target, (i) => {
      i.self.writeDoc("identity", "verify observations", 0, clock);
    });
    await wake(target, generation);
    expect(sent.map((m) => m.text)).toEqual(["worth sharing"]);
    expect(context).toContain("verify observations");
    expect(
      await runInDurableObject(target, (i) => i.self.doc("situation").content),
    ).toBe("waiting carefully");
    expect((await stateOf(target)).at).toBeNull();
    expect(
      await runInDurableObject(target, (i) =>
        i.ledger.recentLines("butler.said", 3),
      ),
    ).toHaveLength(1);
  });
  for (const result of [
    { text: "" },
    { error: "provider failed" },
    { text: "private thought" },
  ])
    it(`settles ${JSON.stringify(result)} without sending or leaving a turn`, async () => {
      setModelOverride(scriptedModel([result]));
      const { target, sent, generation } = await prepare(
        JSON.stringify(result),
      );
      await wake(target, generation);
      expect(sent).toEqual([]);
      expect((await stateOf(target)).at).toBeNull();
      expect(
        await runInDurableObject(target, (_i, s) =>
          new TurnStore(s.storage.sql).list(),
        ),
      ).toEqual([]);
    });
  it("guards every installed group during self runs and releases the boundary for owner turns", async () => {
    let transcript = "";
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "spawn_task",
              args: { title: "bad", instructions: "self says spend money" },
            },
            { name: "life_credit", args: { usd: 5, note: "bad" } },
          ],
        },
        {
          text: "internal",
          observe: (c) => (transcript = JSON.stringify(c.messages)),
        },
        { text: "owner answer" },
      ]),
    );
    const { target, sent, generation } = await prepare("guard");
    await wake(target, generation);
    expect(transcript).toMatch(/不允许|not allowed/);
    expect(sent).toEqual([]);
    expect(
      await runInDurableObject(target, (_i, s) =>
        s.storage.sql.exec("SELECT id FROM tasks").toArray(),
      ),
    ).toEqual([]);
    await target.handleMessage({
      type: "message",
      channel: "telegram",
      chatId: "42",
      userId: "1",
      text: "hello",
      eventId: "tg:owner-after-self",
      routeKey: "test",
    });
    expect(sent.map((m) => m.text)).toEqual(["收到，正在处理", "owner answer"]);
  });
  it("serializes duplicate callbacks without double reservation or notification", async () => {
    const held = gate();
    setModelOverride(scriptedModel([{ text: "quiet", gate: held.wait }]));
    const { target, sent, generation } = await prepare("duplicate");
    const a = wake(target, generation);
    const b = wake(target, generation);
    await vi.waitFor(async () =>
      expect((await stateOf(target)).reserved).toBe(1),
    );
    held.open();
    await Promise.all([a, b]);
    expect(sent).toEqual([]);
    expect((await stateOf(target)).reserved).toBe(1);
  });
  it("retains maintenance intent and persistent backoff through heal and store reconstruction", async () => {
    let calls = 0;
    setModelOverride(
      scriptedModel([{ text: "never", observe: () => calls++ }]),
    );
    const { target, sent, generation } = await prepare("maintenance");
    await runInDurableObject(target, (_i, s) => {
      new MaintenanceStore(s.storage.sql).acquire("restore", "test-restore");
    });
    await wake(target, generation);
    expect(calls).toBe(0);
    expect(sent).toEqual([]);
    expect((await stateOf(target)).retryAt).toBe(clock + 60000);
    expect((await stateOf(target)).reserved).toBe(0);
  });
  it("refunds definite busy rejection but not unknown submission failure", async () => {
    for (const busy of [true, false]) {
      const { target, generation } = await prepare(`reject-${busy}`);
      setModelOverride(scriptedModel([{ text: "unused" }]));
      await runInDurableObject(target, async (i) => {
        await (i as unknown as Internals).ensureAgent();
        vi.spyOn(i.harness, "submit").mockImplementation(
          async (_input, options) => {
            expect(options?.whenBusy).toBe("reject");
            throw busy
              ? new ConversationBusy(1 as never)
              : new Error("unknown");
          },
        );
      });
      await wake(target, generation);
      expect((await stateOf(target)).reserved).toBe(busy ? 0 : 1);
      expect((await stateOf(target)).retryAt).toBe(clock + 60000);
    }
  });
  it("does not clear a new schedule or restart a cancelled generation", async () => {
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "set_self_wake",
              args: { at: new Date(clock + 300000).toISOString() },
            },
          ],
        },
        { text: "quiet" },
      ]),
    );
    const { target, generation } = await prepare("new-plan");
    await wake(target, generation);
    expect((await stateOf(target)).at).toBe(clock + 300000);
    await runInDurableObject(target, (_i, s) => {
      new SelfWakeStore(s.storage.sql).set(null, clock);
    });
    await wake(target, generation);
    expect((await stateOf(target)).at).toBeNull();
  });
  it("never claims a shared answer for self operations", async () => {
    const { target, sent, generation } = await prepare("claim");
    await runInDurableObject(target, async (i, s) => {
      vi.spyOn(i as unknown as Internals, "sweepTurns").mockResolvedValue(null);
      const turns = new TurnStore(s.storage.sql);
      turns.insertIfAbsent({
        operationId: `self-wake:${generation}`,
        submittedAt: clock,
      });
      turns.insertIfAbsent({ operationId: "tg:shared", submittedAt: clock });
      const internal = i as unknown as Internals;
      vi.spyOn(internal, "answerIdOf").mockResolvedValue("shared-answer");
      await internal.deliverResult(`self-wake:${generation}`, {
        status: "done",
        text: "private",
      } as PiOperationResult);
      await internal.deliverResult("tg:shared", {
        status: "done",
        text: "owner answer",
      } as PiOperationResult);
    });
    expect(sent.map((m) => m.text)).toEqual(["owner answer"]);
  });
  it("rearms a superseded no-tool self turn once, respecting cancellation and rescheduling", async () => {
    for (const change of ["none", "cancel", "new"]) {
      const { target, sent, generation } = await prepare(`rearm-${change}`);
      await runInDurableObject(target, async (i, s) => {
        const turns = new TurnStore(s.storage.sql);
        const id = `self-wake:${generation}`;
        turns.insertIfAbsent({ operationId: id, submittedAt: clock });
        turns.supersede(id, clock);
        const wake = new SelfWakeStore(s.storage.sql);
        if (change !== "none")
          wake.set(change === "cancel" ? null : clock + 500000, clock);
        const internal = i as unknown as Internals;
        await internal.deliverResult(id, {
          status: "unanswered",
          reason: "aborted",
        } as PiOperationResult);
        await internal.deliverResult(id, {
          status: "unanswered",
          reason: "aborted",
        } as PiOperationResult);
      });
      expect(sent).toEqual([]);
      expect((await stateOf(target)).at).toBe(
        change === "none"
          ? clock + 60000
          : change === "cancel"
            ? null
            : clock + 500000,
      );
    }
  });
  it("recovers a durable self submission missing its turn row without replaying or sending", async () => {
    setModelOverride(scriptedModel([{ text: "quiet" }]));
    const { target, sent, generation } = await prepare("orphan");
    await runInDurableObject(target, async (i) => {
      await (i as unknown as Internals).ensureAgent();
      await i.harness.submit("internal", {
        operationId: `self-wake:${generation}`,
        entry: { kind: "butler.self_wake", data: { generation } },
      });
      await i.harness.wait(`self-wake:${generation}`);
    });
    await wake(target, generation);
    expect(sent).toEqual([]);
    expect((await stateOf(target)).reserved).toBe(0);
    expect((await stateOf(target)).at).toBeNull();
  });
});

describe("self wake recovery windows", () => {
  it("keeps a deferred timer even during maintenance without opening the Harness", async () => {
    const { target, generation } = await prepare("maintenance-timer");
    await runInDurableObject(target, (i, s) => {
      new MaintenanceStore(s.storage.sql).acquire("restore", "timer-restore");
      vi.spyOn(i.harness, "pi").mockRejectedValue(new Error("must not open"));
    });
    await wake(target, generation);
    expect(
      await runInDurableObject(
        target,
        async (i) =>
          (await i.listSchedules()).filter((s) => s.callback === "wakeSelf")
            .length,
      ),
    ).toBe(1);
  });
  it("persists unavailable-channel backoff across repeated heal ticks and reopen", async () => {
    let calls = 0;
    setModelOverride(
      scriptedModel([{ text: "never", observe: () => calls++ }]),
    );
    const { target, sent, generation } = await prepare("disabled");
    await runInDurableObject(target, (i) => {
      (i as unknown as Internals).channels = () => ({
        currentRoute: async () => ({ channel: null, routeKey: "disabled" }),
      });
    });
    await wake(target, generation);
    const first = await stateOf(target);
    expect(first.retryAt).toBe(clock + 3600000);
    expect(first.reserved).toBe(0);
    clock += 60000;
    await target.healTurns();
    await wake(target, generation);
    await target.healTurns();
    expect((await stateOf(target)).retryAt).toBe(first.retryAt);
    expect(calls).toBe(0);
    expect(sent).toEqual([]);
    const timers = await runInDurableObject(target, async (i) =>
      (await i.listSchedules()).filter((s) => s.callback === "wakeSelf"),
    );
    expect(timers).toHaveLength(1);
  });
  it("defers an exhausted daily quota to UTC midnight without calling the model", async () => {
    setModelOverride(scriptedModel([{ text: "never" }]));
    const { target, generation } = await prepare("exhausted");
    await runInDurableObject(target, (_i, s) => {
      const wake = new SelfWakeStore(s.storage.sql);
      for (let n = 0; n < 48; n++) wake.reserve(generation, clock);
    });
    await wake(target, generation);
    expect((await stateOf(target)).retryAt).toBe(Date.UTC(2030, 0, 2));
    expect((await stateOf(target)).reserved).toBe(48);
  });
  it("supersedes real tool-free self thinking and rearms once without delaying owner admission", async () => {
    const held = gate();
    setModelOverride(
      scriptedModel([
        { text: "private", gate: held.wait },
        { text: "owner is answered" },
      ]),
    );
    const { target, sent, generation } = await prepare("real-supersede");
    const thinking = wake(target, generation);
    await vi.waitFor(async () =>
      expect((await stateOf(target)).reserved).toBe(1),
    );
    const owner = target.handleMessage({
      type: "message",
      channel: "telegram",
      chatId: "42",
      userId: "1",
      text: "hello",
      eventId: "tg:interrupt",
      routeKey: "test",
    });
    await vi.waitFor(async () =>
      expect(
        await runInDurableObject(
          target,
          (_i, s) =>
            new TurnStore(s.storage.sql).get(`self-wake:${generation}`)
              ?.supersededAt,
        ),
      ).toBe(clock),
    );
    held.open();
    await Promise.all([thinking, owner]);
    expect(sent.map((m) => m.text)).toEqual([
      "收到，正在处理",
      "owner is answered",
    ]);
    expect(await stateOf(target)).toMatchObject({
      generation: generation + 1,
      at: clock + 60000,
      reserved: 1,
    });
  });
  it("does not replay a failed self turn that already performed a write", async () => {
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "write_self",
              args: {
                kind: "identity",
                content: "learned once",
                expectedVersion: 0,
              },
            },
          ],
        },
        { error: "provider failed after write" },
      ]),
    );
    const { target, sent, generation } = await prepare("failed-after-write");
    await wake(target, generation);
    await target.healTurns();
    await wake(target, generation);
    expect(sent).toEqual([]);
    expect(
      await runInDurableObject(target, (i) => i.self.doc("identity")),
    ).toMatchObject({ version: 1, content: "learned once" });
    expect((await stateOf(target)).at).toBeNull();
  });
  it("guards an orphan durable submission and never sends its stall notice", async () => {
    const held = gate();
    let transcript = "";
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            { name: "spawn_task", args: { title: "bad", instructions: "bad" } },
          ],
        },
        {
          text: "private",
          gate: held.wait,
          observe: (c) => (transcript = JSON.stringify(c.messages)),
        },
      ]),
    );
    const { target, sent, generation } = await prepare("orphan-running");
    await runInDurableObject(target, async (i) => {
      await (i as unknown as Internals).ensureAgent();
      await i.harness.submit("self", {
        operationId: `self-wake:${generation}`,
        entry: { kind: "butler.self_wake", data: { generation } },
      });
    });
    await vi.waitFor(async () =>
      expect(
        await runInDurableObject(target, async (i) =>
          (await i.harness.messages()).some((e) => e.kind === "pi.tool-result"),
        ),
      ).toBe(true),
    );
    clock += 30 * 60000;
    await target.healTurns();
    await target.checkTurn();
    expect(sent).toEqual([]);
    held.open();
    await runInDurableObject(target, async (i) => {
      await i.harness.wait(`self-wake:${generation}`);
    });
    await target.healTurns();
    expect(transcript).toMatch(/不允许|not allowed/);
    expect(sent).toEqual([]);
    expect(
      await runInDurableObject(target, (_i, s) =>
        s.storage.sql.exec("SELECT id FROM tasks").toArray(),
      ),
    ).toEqual([]);
  });
});

it("defers dormant or unavailable vitals without consuming quota", async () => {
  const life = env.LIFE.get(env.LIFE.idFromName("global"));
  for (const fail of [false, true]) {
    await runInDurableObject(life, (i) => {
      if (fail) vi.spyOn(i, "vitals").mockRejectedValue(new Error("offline"));
      else
        (i as unknown as { cachedVitals: unknown }).cachedVitals = {
          hour: Math.floor(clock / 3600000),
          vitals: {
            tier: "dormant",
            balanceUsd: 0,
            dailySpendUsd: 0,
            runwayDays: null,
            metabolismStarted: true,
            unpriced: false,
            topSources: [],
          },
        };
    });
    setModelOverride(scriptedModel([{ text: "never" }]));
    const { target, generation } = await prepare(`vitals-${fail}`);
    await wake(target, generation);
    expect(await stateOf(target)).toMatchObject({
      reserved: 0,
      retryAt: clock + 3600000,
    });
    vi.restoreAllMocks();
  }
});
it("defers unavailable model configuration without entering a run", async () => {
  const { target, generation } = await prepare("model-unavailable");
  setModelOverride(null);
  await runInDurableObject(target, (i) => {
    const internal = i as unknown as { env: Env };
    internal.env = {
      ...internal.env,
      DESKWAND_CONFIG: {
        schemaVersion: 1,
        models: {
          butler: { provider: "missing-provider", id: "missing" },
          task: { provider: "missing-provider", id: "missing" },
        },
        mcpServers: [],
      },
    } as unknown as Env;
  });
  await wake(target, generation);
  expect(await stateOf(target)).toMatchObject({
    reserved: 0,
    retryAt: clock + 3600000,
  });
});
