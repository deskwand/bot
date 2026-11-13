import { PiHarness, PiSession } from "agents/harness/pi";
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel, type ScriptedTurn } from "../helpers/scripted-model";
import { mapSettledFailureToRestartLimit, operationIdOf } from "../helpers/task-recovery";

const owner = () => env.BUTLER.get(env.BUTLER.idFromName("owner"));
const recoveryModels = new Map<Stub, ReturnType<typeof scriptedModel>>();
const task = (id: string) => env.TASK.get(env.TASK.idFromName(id));
type Stub = ReturnType<typeof task>;
type Gate = { entered: boolean; released: boolean };
type Internals = {
  ensureMcpTools(): Promise<void>;
  failWith(reason: string, retryable: boolean): Promise<void>;
  watchRun(operationId: string): Promise<void>;
  gate?: Gate;
  oldGate?: Gate;
  lateWatch?: Promise<void>;
  setMeta(key: string, value: string): void;
  readMeta(key: string): string | undefined;
  butlerMaintenanceActive(): Promise<boolean>;
  maintenanceMode?: "active" | "unavailable" | "released";
  resumeRetryAdmission(): Promise<boolean>;
  outboxFor(taskId: string): { flush(): Promise<boolean> };
  claimRetryRound(taskId: string): { operationId: string; previousOperationId?: string; started: boolean };
  recordRetryStarted(intent: { operationId: string; previousOperationId?: string; started: boolean }, taskId: string): { operationId: string; previousOperationId?: string; started: boolean };
};

beforeEach(async () => {
  setChannelOverride("telegram", fakeChannel().adapter);
  await runInDurableObject(owner(), (instance) => {
    (instance as unknown as { completeSpeak(): Promise<string> }).completeSpeak = async () => "";
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setModelOverride(null);
  setChannelOverride("telegram", null);
  recoveryModels.clear();
});

async function failedTask(id: string, turns: ScriptedTurn[] = [{ text: "recovered" }]) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const stub = task(id);
  recoveryModels.set(stub, scriptedModel(turns));
  setModelOverride(scriptedModel([{ error: "synthetic run failure" }]));
  mapSettledFailureToRestartLimit(`task:${id}`);
  await stub.start({ taskId: id, title: id, instructions: "recover this work" });
  await vi.waitFor(async () => expect((await stub.status()).state).toBe("failed"));
  expect(await runInDurableObject(stub, (instance) => instance.harness.pending())).toEqual([]);
  await env.ARTIFACTS.put(`work/${id}/draft.md`, "keep this draft");
  return stub;
}

async function setRecovery(stub: Stub) {
  const model = recoveryModels.get(stub)!;
  await runInDurableObject(stub, (instance) => instance.harness.session().setModel(model));
}

async function holdSetup(stub: Stub, fail = false) {
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as Internals;
    const original = target.ensureMcpTools.bind(target);
    const gate: Gate = { entered: false, released: false };
    target.gate = gate;
    target.ensureMcpTools = async () => {
      gate.entered = true;
      while (!gate.released) await new Promise((resolve) => setTimeout(resolve, 5));
      if (fail) throw new Error("setup failed");
      await original();
    };
  });
}

async function entered(stub: Stub) {
  await vi.waitFor(async () => expect(await runInDurableObject(stub, (instance) =>
    (instance as unknown as Internals).gate?.entered,
  )).toBe(true));
}

async function release(stub: Stub) {
  await runInDurableObject(stub, (instance) => {
    const gate = (instance as unknown as Internals).gate;
    if (gate) gate.released = true;
  });
}

async function completed(stub: Stub, id: string) {
  const operationId = await operationIdOf(stub);
  expect(operationId).toMatch(new RegExp(`^task:${id}:retry:`));
  const result = await runInDurableObject(stub, (instance) => instance.harness.wait(operationId!));
  expect(result.status).toBe("done");
  await vi.waitFor(async () => expect((await stub.status()).state).toBe("completed"));
}

async function events(id: string) {
  return (await owner().debugEvents(id)).map((event) => event.type);
}

describe("TaskDO recovery rounds", () => {
  it("persists started before an immediate finish_task", async () => {
    const id = "recover-fast";
    const stub = await failedTask(id, [{ toolCalls: [{ name: "finish_task", args: { summary: "fast completion" } }] }]);
    await setRecovery(stub);
    expect((await stub.retryTask()).ok).toBe(true);
    await completed(stub, id);
    expect(await events(id)).toEqual(["started", "failed", "started", "completed"]);
    const row = await runInDurableObject(owner(), (instance) => {
      const target = instance as unknown as { repo: { get(id: string): { status: string } | undefined } };
      return target.repo.get(id);
    });
    expect(row?.status).toBe("completed");
  });

  it("claims the round before asynchronous setup so only one retry wins", async () => {
    const id = "recover-concurrent";
    const stub = await failedTask(id);
    await setRecovery(stub);
    await holdSetup(stub);
    const admission = vi.spyOn(PiSession.prototype, "continue");
    const first = stub.retryTask();
    await entered(stub);
    const second = await stub.retryTask();
    expect(second.ok).toBe(false);
    expect(await operationIdOf(stub)).toBe(`task:${id}:retry:1`);
    await release(stub);
    expect((await first).ok).toBe(true);
    expect(admission).toHaveBeenCalledTimes(1);
    await completed(stub, id);
    expect(await events(id)).toEqual(["started", "failed", "started", "completed"]);
  });

  it("restores the failed claim after setup fails and permits another retry", async () => {
    const id = "recover-setup";
    const stub = await failedTask(id);
    await setRecovery(stub);
    const original = await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as Internals;
      const original = target.ensureMcpTools;
      target.ensureMcpTools = async () => { throw new Error("setup failed"); };
      return original;
    });
    const admission = vi.spyOn(PiSession.prototype, "continue");
    expect((await stub.retryTask()).ok).toBe(false);
    expect((await stub.status()).state).toBe("failed");
    expect(await operationIdOf(stub)).toBe(`task:${id}`);
    expect(await events(id)).toEqual(["started", "failed"]);
    expect(admission).not.toHaveBeenCalled();
    expect(await (await env.ARTIFACTS.get(`work/${id}/draft.md`))!.text()).toBe("keep this draft");
    await runInDurableObject(stub, (instance) => { (instance as unknown as Internals).ensureMcpTools = original; });
    expect((await stub.retryTask()).ok).toBe(true);
    expect(await operationIdOf(stub)).toBe(`task:${id}:retry:2`);
    await completed(stub, id);
  });

  it("ends a refused admission retryably and does not discard drafts", async () => {
    const id = "recover-admission";
    const stub = await failedTask(id);
    await setRecovery(stub);
    vi.spyOn(PiSession.prototype, "continue").mockRejectedValueOnce(new Error("admission refused"));
    expect((await stub.retryTask()).ok).toBe(false);
    expect((await stub.status()).state).toBe("failed");
    expect(await events(id)).toEqual(["started", "failed", "started", "failed"]);
    expect((await owner().debugEvents(id)).at(-1)?.payload).toMatchObject({ retryable: true });
    expect(await (await env.ARTIFACTS.get(`work/${id}/draft.md`))!.text()).toBe("keep this draft");
    expect((await stub.retryTask()).ok).toBe(true);
    expect(await operationIdOf(stub)).toBe(`task:${id}:retry:2`);
    await completed(stub, id);
  });

  it("does not strand an admitted operation if stall-watch setup fails", async () => {
    const id = "recover-stall";
    const stub = await failedTask(id);
    await setRecovery(stub);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { beginStallWatch(): Promise<void> }).beginStallWatch = async () => {
        throw new Error("timer unavailable");
      };
    });
    expect((await stub.retryTask()).ok).toBe(true);
    await completed(stub, id);
    expect(await events(id)).toEqual(["started", "failed", "started", "completed"]);
  });

  it("does not overwrite cancellation during asynchronous retry setup", async () => {
    const id = "recover-cancel";
    const stub = await failedTask(id);
    await setRecovery(stub);
    await holdSetup(stub);
    const admission = vi.spyOn(PiSession.prototype, "continue");
    const retry = stub.retryTask();
    await entered(stub);
    expect((await stub.cancel()).ok).toBe(true);
    await release(stub);
    expect((await retry).ok).toBe(false);
    expect(admission).not.toHaveBeenCalled();
    expect((await stub.status()).state).toBe("cancelled");
    expect(await events(id)).toEqual(["started", "failed", "cancelled"]);
  });

  it("withdraws only the retry operation when cancellation lands during admission", async () => {
    const id = "recover-cancel-admission";
    const stub = await failedTask(id);
    await setRecovery(stub);
    const abort = vi.spyOn(PiHarness.prototype, "abort");
    await runInDurableObject(stub, (instance) => {
      const gate: Gate = { entered: false, released: false };
      (instance as unknown as Internals).gate = gate;
      const original = PiSession.prototype.continue;
      vi.spyOn(PiSession.prototype, "continue").mockImplementation(async function (this: PiSession, options) {
        gate.entered = true;
        while (!gate.released) await new Promise((resolve) => setTimeout(resolve, 5));
        return original.call(this, options);
      });
    });
    const retry = stub.retryTask();
    await entered(stub);
    expect((await stub.cancel()).ok).toBe(true);
    await release(stub);
    expect((await retry).ok).toBe(false);
    expect(abort).toHaveBeenCalledWith({ operationId: `task:${id}:retry:1` });
    expect((await stub.status()).state).toBe("cancelled");
    expect(await events(id)).toEqual(["started", "failed", "started", "cancelled"]);
    expect(await runInDurableObject(stub, (instance) => instance.harness.pending())).toEqual([]);
  });

  it.each(["claimed", "started", "accepted"])("recovers the durable %s admission snapshot after eviction", async (phase) => {
    const id = `recover-snapshot-${phase}`;
    let draftRead = false;
    const stub = await failedTask(id, [
      { toolCalls: [{ name: "read", args: { path: "draft.md" } }] },
      { text: "recovered after eviction", observe: (context) => {
        draftRead = JSON.stringify(context.messages).includes("keep this draft");
      } },
    ]);
    await setRecovery(stub);
    const operationId = `task:${id}:retry:1`;
    await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as Internals;
      const intent = target.claimRetryRound(id);
      expect(intent.operationId).toBe(operationId);
      if (phase !== "claimed") target.recordRetryStarted(intent, id);
      if (phase === "accepted") {
        // Pi accepted, but emulate the process stopping before local intent
        // cleanup and watcher attachment. The submission and result are real.
        await instance.harness.session().continue({ operationId });
        expect((await instance.harness.wait(operationId)).status).toBe("done");
      } else {
        expect(await instance.harness.pending()).toEqual([]);
      }
    });
    await evictDurableObject(stub);
    if (phase === "claimed") {
      expect((await stub.status()).state).toBe("failed");
      expect(await operationIdOf(stub)).toBe(`task:${id}`);
      expect(await events(id)).toEqual(["started", "failed"]);
      expect((await owner().debugEvents(id)).at(-1)?.payload).toMatchObject({ retryable: true });
      expect(await (await env.ARTIFACTS.get(`work/${id}/draft.md`))!.text()).toBe("keep this draft");
      expect((await stub.retryTask()).ok).toBe(true);
      expect(await operationIdOf(stub)).toBe(`task:${id}:retry:2`);
    }
    await completed(stub, id);
    expect(draftRead).toBe(true);
    expect(await events(id)).toEqual(["started", "failed", "started", "completed"]);
    expect(await runInDurableObject(stub, (instance) =>
      (instance as unknown as Internals).readMeta("retry_admission"),
    )).toBeUndefined();
    if (phase === "accepted") {
      const receipt = await runInDurableObject(stub, (instance) =>
        instance.harness.session().continue({ operationId }),
      );
      expect(receipt.accepted).toBe(false);
    }
  });

  it("does not attach liveness to a retry whose admission has not reached Pi", async () => {
    const id = "recover-liveness-admission";
    const stub = await failedTask(id);
    await setRecovery(stub);
    await holdSetup(stub);
    const wait = vi.spyOn(PiHarness.prototype, "wait");
    wait.mockClear();
    const retry = stub.retryTask();
    await entered(stub);
    expect(await stub.liveness()).toMatchObject({ state: "running", reattached: false });
    expect(wait.mock.calls.some(([id]) => id === "task:recover-liveness-admission:retry:1")).toBe(false);
    expect(await events(id)).toEqual(["started", "failed"]);
    expect(await (await env.ARTIFACTS.get(`work/${id}/draft.md`))!.text()).toBe("keep this draft");
    await release(stub);
    expect((await retry).ok).toBe(true);
    await completed(stub, id);
  });

  it.each(["active", "unavailable"] as const)("defers interrupted admission while maintenance is %s", async (mode) => {
    const id = `recover-maintenance-${mode}`;
    const stub = await failedTask(id);
    await setRecovery(stub);
    const admission = vi.spyOn(PiSession.prototype, "continue");
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as Internals;
      const intent = target.claimRetryRound(id);
      target.recordRetryStarted(intent, id);
      target.maintenanceMode = mode;
      const original = target.butlerMaintenanceActive.bind(target);
      target.butlerMaintenanceActive = async () => {
        if (target.maintenanceMode === "active") return true;
        if (target.maintenanceMode === "unavailable") throw new Error("maintenance lookup unavailable");
        return original();
      };
    });
    // Both the normal outbox path and the direct recovery flush must defer.
    const flush = await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as Internals;
      return vi.spyOn(target.outboxFor(id), "flush");
    });
    await stub.liveness();
    await runInDurableObject(stub, (instance) => (instance as unknown as Internals).resumeRetryAdmission());
    expect(admission).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect((await stub.status()).state).toBe("running");
    expect(await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as Internals;
      return [target.readMeta("startup_deferred"), target.readMeta("retry_admission")];
    })).toEqual(["1", expect.stringContaining(`task:${id}:retry:1`)]);
    expect(await (await env.ARTIFACTS.get(`work/${id}/draft.md`))!.text()).toBe("keep this draft");
    await runInDurableObject(stub, async (instance) => {
      (instance as unknown as Internals).maintenanceMode = "released";
      await instance.alarm();
    });
    await completed(stub, id);
    expect(admission).toHaveBeenCalledWith({ operationId: `task:${id}:retry:1` });
    expect(await events(id)).toEqual(["started", "failed", "started", "completed"]);
  });

  it("returns success when finish_task settles before the admission receipt returns", async () => {
    const id = "recover-finish-before-receipt";
    const stub = await failedTask(id, [{ toolCalls: [{ name: "finish_task", args: { summary: "fast" } }] }]);
    await setRecovery(stub);
    const original = PiSession.prototype.continue;
    vi.spyOn(PiSession.prototype, "continue").mockImplementation(async function (this: PiSession, options) {
      const receipt = await original.call(this, options);
      await this.wait(receipt.operationId);
      return receipt;
    });
    expect((await stub.retryTask()).ok).toBe(true);
    await completed(stub, id);
    expect(await events(id)).toEqual(["started", "failed", "started", "completed"]);
  });

  it.each(["done", "unanswered", "throw"])("ignores a stale watcher's %s outcome", async (outcome) => {
    const id = `recover-stale-${outcome}`;
    const stub = await failedTask(id, [
      { toolCalls: [{ name: "hold_recovery", args: {} }] },
      { text: "new round completed" },
    ]);
    const oldId = `task:${id}`;
    const Empty = Type.Object({});
    await runInDurableObject(stub, (instance) => {
      const gate: Gate = { entered: false, released: false };
      (instance as unknown as Internals).gate = gate;
      const tool: ToolRegistration<typeof Empty> = {
        name: "hold_recovery",
        description: "Keep the new run alive while the old watcher returns.",
        parameters: Empty,
        async execute() {
          gate.entered = true;
          while (!gate.released) await new Promise((resolve) => setTimeout(resolve, 5));
          return { output: [{ type: "text", text: "released" }] };
        },
      };
      instance.registry.install({ name: "test-recovery-hold", tools: [tool] });
    });
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as Internals;
      const originalWait = instance.harness.wait.bind(instance.harness);
      const gate: Gate = { entered: false, released: false };
      target.oldGate = gate;
      instance.harness.wait = async (operationId, options) => {
        const result = await originalWait(operationId, options);
        if (operationId !== oldId) return result;
        gate.entered = true;
        while (!gate.released) await new Promise((resolve) => setTimeout(resolve, 5));
        if (outcome === "throw") throw new Error("old waiter failed");
        return { ...result, status: outcome as "done" | "unanswered", reason: "model_error" };
      };
      // Reproduce a watcher already waiting when the known old failure is
      // recorded. Its underlying operation really settled in failedTask().
      target.setMeta("state", "running");
      target.lateWatch = target.watchRun(oldId);
    });
    await vi.waitFor(async () => expect(await runInDurableObject(stub, (instance) =>
      (instance as unknown as Internals).oldGate?.entered,
    )).toBe(true));
    await runInDurableObject(stub, (instance) => (instance as unknown as Internals).setMeta("state", "failed"));
    await setRecovery(stub);
    expect((await stub.retryTask()).ok).toBe(true);
    await entered(stub);
    await runInDurableObject(stub, (instance) => {
      const gate = (instance as unknown as Internals).oldGate;
      if (gate) gate.released = true;
    });
    await runInDurableObject(stub, (instance) => (instance as unknown as Internals).lateWatch);
    expect(await operationIdOf(stub)).toBe(`task:${id}:retry:1`);
    expect((await stub.status()).state).toBe("running");
    expect(await events(id)).toEqual(["started", "failed", "started"]);
    expect(await (await env.ARTIFACTS.get(`work/${id}/draft.md`))!.text()).toBe("keep this draft");
    await release(stub);
    await completed(stub, id);
  });
});
