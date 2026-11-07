import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import type { TaskControl } from "../../src/butler/tools";
import type { ChannelMessageRef, OutboundMessage } from "../../src/protocol";
import { STALL_AFTER_MS } from "../../src/task/stall";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const START = Date.UTC(2030, 0, 1, 9, 0, 0);

let now = START;

beforeEach(() => {
  now = START;
  setClockOverride({
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
});

afterEach(() => {
  setClockOverride(null);
  vi.restoreAllMocks();
});

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

type ButlerStub = ReturnType<typeof butler>;

type Probe = (id: string) => Promise<{ state: string; reattached: boolean }>;

/** Replaces the Task DO stub with a recorder; only `liveness` is exercised. */
async function installProbe(
  stub: ButlerStub,
  probe: Probe,
): Promise<string[]> {
  const probed: string[] = [];
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { taskFor(id: string): TaskControl }).taskFor = (
      id,
    ) => ({
      start: async () => {},
      status: async () => ({ state: "running", title: "" }),
      steer: async () => ({ ok: true, message: "" }),
      cancel: async () => ({ ok: true, message: "" }),
      retryTask: async () => ({ ok: true, message: "" }),
      pendingApprovals: async () => [],
      liveness: async () => {
        probed.push(id);
        return probe(id);
      },
    });
  });
  return probed;
}

/** Records sends without touching a channel or the network. */
async function captureSends(stub: ButlerStub): Promise<OutboundMessage[]> {
  const sent: OutboundMessage[] = [];
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { channels(): unknown }).channels = () => ({
      currentRoute: async () => ({ channel: "telegram", routeKey: "test" }),
      isAdmissionCurrent: async () => true,
      editCurrent: async (_ref: ChannelMessageRef) => true,
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

async function seedTask(
  stub: ButlerStub,
  row: { id: string; status: string; botId?: string | null },
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO tasks
        (id, title, status, created_at, updated_at, chat_id, artifacts_json,
         last_seq, bot_id, handle)
       VALUES (?, ?, ?, 0, 0, '42', '[]', 0, ?, ?)`,
      row.id,
      `任务 ${row.id}`,
      row.status,
      row.botId ?? null,
      row.botId == null ? 1 : null,
    );
  });
}

async function taskStatus(stub: ButlerStub, taskId: string) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ status: string }>(
        `SELECT status FROM tasks WHERE id = ?`,
        taskId,
      )
      .toArray()[0]?.status,
  );
}

describe("ButlerDO.healTasks", () => {
  it("is throttled to once per STALL_AFTER_MS", async () => {
    const stub = butler("heal-throttle");
    const probed = await installProbe(stub, async () => ({
      state: "running",
      reattached: false,
    }));
    await seedTask(stub, { id: "t1", status: "running" });

    expect(await stub.healTasks()).toEqual({ checked: 1, interrupted: 0 });

    now += STALL_AFTER_MS - 1;
    expect(await stub.healTasks()).toBeNull();
    expect(probed).toEqual(["t1"]);

    now += 1;
    expect(await stub.healTasks()).toEqual({ checked: 1, interrupted: 0 });
    expect(probed).toEqual(["t1", "t1"]);
  });

  it("does not interrupt on a single failed probe", async () => {
    const stub = butler("heal-one-failure");
    await installProbe(stub, async () => {
      throw new Error("stub unavailable");
    });
    const sent = await captureSends(stub);
    await seedTask(stub, { id: "t1", status: "running" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await stub.healTasks()).toEqual({ checked: 1, interrupted: 0 });
    expect(sent).toEqual([]);
    expect(await taskStatus(stub, "t1")).toBe("running");
  });

  it("interrupts after two consecutive failed probes", async () => {
    const stub = butler("heal-two-failures");
    await installProbe(stub, async () => {
      throw new Error("stub unavailable");
    });
    const sent = await captureSends(stub);
    await seedTask(stub, { id: "t1", status: "running" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await stub.healTasks();
    now += STALL_AFTER_MS;
    expect(await stub.healTasks()).toEqual({ checked: 1, interrupted: 1 });

    expect(await taskStatus(stub, "t1")).toBe("failed");
    expect(sent).toEqual([
      {
        text: expect.stringContaining("任务中断了，后台没有响应"),
        priority: "critical",
      },
    ]);
    expect(sent[0]?.text).not.toContain("重试");
  });

  it("resets the failure count after a successful probe", async () => {
    const stub = butler("heal-reset");
    let fail = true;
    await installProbe(stub, async () => {
      if (fail) throw new Error("stub unavailable");
      return { state: "running", reattached: false };
    });
    const sent = await captureSends(stub);
    await seedTask(stub, { id: "t1", status: "running" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await stub.healTasks();

    fail = false;
    now += STALL_AFTER_MS;
    await stub.healTasks();

    fail = true;
    now += STALL_AFTER_MS;
    expect(await stub.healTasks()).toEqual({ checked: 1, interrupted: 0 });

    expect(await taskStatus(stub, "t1")).toBe("running");
    expect(sent).toEqual([]);
  });

  it("counts a probe that reports a non-running state as a failure", async () => {
    const stub = butler("heal-not-running");
    await installProbe(stub, async () => ({
      state: "queued",
      reattached: false,
    }));
    const sent = await captureSends(stub);
    await seedTask(stub, { id: "t1", status: "running" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await stub.healTasks()).toEqual({ checked: 1, interrupted: 0 });
    expect(await taskStatus(stub, "t1")).toBe("running");

    now += STALL_AFTER_MS;
    expect(await stub.healTasks()).toEqual({ checked: 1, interrupted: 1 });

    expect(await taskStatus(stub, "t1")).toBe("failed");
    expect(sent).toEqual([
      {
        text: expect.stringContaining("任务中断了，后台没有响应"),
        priority: "critical",
      },
    ]);
  });

  it("counts a completed probe whose row is still running, without interrupting yet", async () => {
    const stub = butler("heal-completed-probe");
    await installProbe(stub, async () => ({
      state: "completed",
      reattached: false,
    }));
    const sent = await captureSends(stub);
    await seedTask(stub, { id: "t1", status: "running" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await stub.healTasks()).toEqual({ checked: 1, interrupted: 0 });
    expect(await taskStatus(stub, "t1")).toBe("running");
    expect(sent).toEqual([]);

    // It was counted: the next unsuccessful sweep interrupts.
    now += STALL_AFTER_MS;
    expect(await stub.healTasks()).toEqual({ checked: 1, interrupted: 1 });
  });

  it("clears the probe failure count when a terminal event arrives", async () => {
    const stub = butler("heal-reset-on-terminal");
    await installProbe(stub, async () => {
      throw new Error("stub unavailable");
    });
    const sent = await captureSends(stub);
    await seedTask(stub, { id: "t1", status: "running" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await stub.healTasks()).toEqual({ checked: 1, interrupted: 0 });

    await stub.report({
      taskId: "t1",
      seq: 1,
      type: "completed",
      summary: "done",
      artifacts: [],
    });
    // The retry keeps the id: a fresh run starts with a clean counter.
    await stub.report({ taskId: "t1", seq: 2, type: "started" });

    now += STALL_AFTER_MS;
    expect(await stub.healTasks()).toEqual({ checked: 1, interrupted: 0 });
    expect(await taskStatus(stub, "t1")).toBe("running");
    expect(sent.filter((entry) => entry.text.includes("任务中断了"))).toEqual(
      [],
    );
  });

  it("probes only running tasks", async () => {
    const stub = butler("heal-running-only");
    const probed = await installProbe(stub, async () => ({
      state: "running",
      reattached: false,
    }));
    await seedTask(stub, { id: "t1", status: "running" });
    await seedTask(stub, { id: "t2", status: "queued" });
    await seedTask(stub, { id: "t3", status: "completed" });

    expect(await stub.healTasks()).toEqual({ checked: 1, interrupted: 0 });
    expect(probed).toEqual(["t1"]);
  });
});
