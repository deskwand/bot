import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFER_MS,
  LEASE_MS,
  MaintenanceStore,
} from "../../src/admin/maintenance";
import {
  setChannelOverride,
  setILinkFetchOverride,
  setPollTimingOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import type { MessageEvent } from "../../src/protocol";
import { readRuntimeConfig } from "../../src/runtime-config";
import worker from "../../src/index";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const OWNER = "wx-owner";
const TELEGRAM_OWNER = readRuntimeConfig(
  env as unknown as Env,
).owner.telegramUserIds[0]!;

const CREDS = {
  token: "token-a",
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "account-a",
  userId: OWNER,
};

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

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

function harness(name: string) {
  return env.TEST_HARNESS.get(env.TEST_HARNESS.idFromName(name));
}

function butler(name = "owner") {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function channels(name: string) {
  return env.CHANNELS.get(env.CHANNELS.idFromName(name));
}

function task(name: string) {
  return env.TASK.get(env.TASK.idFromName(name));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

async function readWeChatState(hub: ReturnType<typeof channels>) {
  return runInDurableObject(hub, (_instance, state) =>
    state.storage.sql
      .exec<{ cursor: string | null; status: string | null }>(
        `SELECT cursor, status FROM wechat_state LIMIT 1`,
      )
      .toArray()[0] ?? null,
  );
}

async function cancelSchedules(hub: ReturnType<typeof channels>) {
  await runInDurableObject(hub, async (instance) => {
    for (const schedule of await instance.listSchedules()) {
      await instance.cancelSchedule(schedule.id);
    }
  });
}

async function captureButlerMessages(): Promise<{
  events: MessageEvent[];
  restore(): Promise<void>;
}> {
  const events: MessageEvent[] = [];
  const stub = butler();
  let original: ((evt: MessageEvent) => Promise<void>) | undefined;

  await runInDurableObject(stub, (instance) => {
    const proto = Object.getPrototypeOf(instance) as {
      handleMessage(evt: MessageEvent): Promise<void>;
    };
    original = proto.handleMessage;
    proto.handleMessage = async (evt) => {
      events.push(evt);
    };
  });

  return {
    events,
    async restore() {
      await runInDurableObject(stub, (instance) => {
        const proto = Object.getPrototypeOf(instance) as {
          handleMessage(evt: MessageEvent): Promise<void>;
        };
        proto.handleMessage = original!;
      });
    },
  };
}

beforeEach(() => {
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  setPollTimingOverride({ runMs: 0, baseBackoffMs: 1, manualStart: true });
  setWeChatCredentialsOverride(null);
});

afterEach(async () => {
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  setILinkFetchOverride(null);
  setPollTimingOverride(null);
  setWeChatCredentialsOverride(null);
  restoreEnv();
  vi.restoreAllMocks();
  // TaskDO always asks the "owner" Butler, so leases there outlive a test.
  await runInDurableObject(butler(), (_instance, state) => {
    state.storage.sql.exec(`DROP TABLE IF EXISTS admin_maintenance`);
  });
});

describe("MaintenanceStore", () => {
  it("expires a lease after LEASE_MS", async () => {
    const result = await runInDurableObject(
      harness("maintenance-expire"),
      (_instance, state) => {
        let now = 0;
        const store = new MaintenanceStore(state.storage.sql, () => now);
        const lease = store.acquire("export", "a");
        const atStart = store.current();
        now = LEASE_MS + 1;
        const expired = store.current();
        return { lease, atStart, expired };
      },
    );

    expect(result.lease).toEqual({ until: LEASE_MS, op: "export", opId: "a" });
    expect(result.atStart).toEqual(result.lease);
    expect(result.expired).toBeNull();
  });

  it("rejects a second operation while a lease is live", async () => {
    const result = await runInDurableObject(
      harness("maintenance-busy"),
      (_instance, state) => {
        const store = new MaintenanceStore(state.storage.sql, () => 0);
        const first = store.acquire("export", "a");
        const second = store.acquire("restore", "b");
        return { first, second, current: store.current() };
      },
    );

    expect(result.first).not.toBe("busy");
    expect(result.second).toBe("busy");
    expect(result.current).toEqual(result.first);
  });

  it("renews only for the matching opId", async () => {
    const result = await runInDurableObject(
      harness("maintenance-renew"),
      (_instance, state) => {
        let now = 0;
        const store = new MaintenanceStore(state.storage.sql, () => now);
        store.acquire("export", "a");
        now = 1000;
        const wrong = store.renew("b");
        const right = store.renew("a");
        return { wrong, right, current: store.current() };
      },
    );

    expect(result.wrong).toBe(false);
    expect(result.right).toBe(true);
    expect(result.current).toEqual({
      until: 1000 + LEASE_MS,
      op: "export",
      opId: "a",
    });
  });

  it("releases only for the matching opId", async () => {
    const result = await runInDurableObject(
      harness("maintenance-release"),
      (_instance, state) => {
        const store = new MaintenanceStore(state.storage.sql, () => 0);
        store.acquire("export", "a");
        store.release("b");
        const afterWrong = store.current();
        store.release("a");
        const afterRight = store.current();
        return { afterWrong, afterRight };
      },
    );

    expect(result.afterWrong).not.toBeNull();
    expect(result.afterRight).toBeNull();
  });
});

describe("maintenance lease pauses", () => {
  it("rejects a Telegram update while a lease is live", async () => {
    const hub = channels("maintenance-webhook");
    await hub.acquireMaintenance("export", "op-webhook");

    await expect(
      hub.handleTelegramUpdate({ update_id: 1 }),
    ).resolves.toBe("maintenance");
  });

  it("accepts the Telegram update again after the lease expires", async () => {
    const hub = channels("maintenance-webhook-expired");
    await hub.acquireMaintenance("export", "op-expired");
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE admin_maintenance SET until = ?`,
        Date.now() - 1,
      );
    });

    await expect(
      hub.handleTelegramUpdate({ update_id: 1 }),
    ).resolves.toBe("accepted");
  });

  it("returns maintenance when dispatch is fenced", async () => {
    const hub = channels("maintenance-fence");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parsed = false;

    setChannelOverride("telegram", {
      async parseInbound() {
        parsed = true;
        await gate;
        return {
          type: "message",
          channel: "telegram",
          chatId: "42",
          userId: String(TELEGRAM_OWNER),
          text: "hi",
          eventId: "tg:1",
        };
      },
      async send() {
        return { messageId: "" };
      },
      async edit() {},
      async answerAction() {},
    });
    const captured = await captureButlerMessages();

    try {
      const pending = hub.handleTelegramUpdate({ update_id: 1 });
      await vi.waitFor(() => expect(parsed).toBe(true));
      await hub.acquireMaintenance("export", "op-fence");
      release();

      await expect(pending).resolves.toBe("maintenance");
      expect(captured.events).toEqual([]);
    } finally {
      await captured.restore();
    }
  });

  it("runs the Butler alarm again after the lease expires", async () => {
    const stub = butler("maintenance-alarm-expired");
    const ran: string[] = [];

    await runInDurableObject(stub, async (instance, state) => {
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
      proto.maintenanceAlarmProbe = async () => {
        ran.push("ran");
      };
      await instance.acquireMaintenance("export", "op-alarm-expired");
      state.storage.sql.exec(
        `UPDATE admin_maintenance SET until = ?`,
        Date.now() - 1,
      );
      await (
        instance as unknown as {
          schedule(when: number, callback: string): Promise<unknown>;
        }
      ).schedule(0, "maintenanceAlarmProbe");
      await instance.alarm();
    });

    expect(ran).toEqual(["ran"]);
  });

  it("defers the Task alarm while the Butler holds a lease", async () => {
    await butler().acquireMaintenance("export", "op-task-alarm");
    const stub = task("maintenance-task-alarm");

    const at = await runInDurableObject(stub, async (instance, state) => {
      await instance.alarm();
      return state.storage.getAlarm();
    });

    expect(at).not.toBeNull();
    expect(Math.abs(at! - (Date.now() + DEFER_MS))).toBeLessThan(5000);
  });

  it("re-arms the Task alarm when the Butler check fails", async () => {
    const stub = task("maintenance-task-alarm-error");
    let original!: () => Promise<boolean>;
    await runInDurableObject(stub, (instance) => {
      const proto = Object.getPrototypeOf(instance) as {
        butlerMaintenanceActive(): Promise<boolean>;
      };
      original = proto.butlerMaintenanceActive;
      proto.butlerMaintenanceActive = async () => {
        throw new Error("butler down");
      };
    });

    try {
      const at = await runInDurableObject(stub, async (instance, state) => {
        await expect(instance.alarm()).resolves.toBeUndefined();
        return state.storage.getAlarm();
      });

      expect(at).not.toBeNull();
      expect(Math.abs(at! - (Date.now() + DEFER_MS))).toBeLessThan(5000);
    } finally {
      await runInDurableObject(stub, (restored) => {
        (
          Object.getPrototypeOf(restored) as {
            butlerMaintenanceActive(): Promise<boolean>;
          }
        ).butlerMaintenanceActive = original;
      });
    }
  });

  it("defers the Butler alarm while a lease is live", async () => {
    const stub = butler("maintenance-alarm");
    const ran: string[] = [];

    const result = await runInDurableObject(stub, async (instance, state) => {
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
      proto.maintenanceAlarmProbe = async () => {
        ran.push("ran");
      };
      await instance.acquireMaintenance("export", "op-alarm");
      await (
        instance as unknown as {
          schedule(when: number, callback: string): Promise<unknown>;
        }
      ).schedule(0, "maintenanceAlarmProbe");
      await instance.alarm();
      return {
        at: await state.storage.getAlarm(),
        callbacks: (await instance.listSchedules()).map(
          (schedule) => schedule.callback,
        ),
      };
    });

    expect(ran).toEqual([]);
    expect(result.callbacks).toContain("maintenanceAlarmProbe");
    expect(result.at).not.toBeNull();
    expect(Math.abs(result.at! - (Date.now() + DEFER_MS))).toBeLessThan(5000);
  });

  it("does not poll WeChat while a lease is live", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    setPollTimingOverride({ runMs: 0, baseBackoffMs: 1, manualStart: true });

    const hub = channels("maintenance-wechat-idle");
    await hub.ensurePolling();
    await cancelSchedules(hub);
    await hub.acquireMaintenance("export", "op-idle");

    // With an automatic start enabled, only the lease keeps ensurePolling
    // from scheduling a new chain.
    setPollTimingOverride({ runMs: 0, baseBackoffMs: 1 });
    const scheduled = await runInDurableObject(hub, async (instance) => {
      await instance.ensurePolling();
      return (await instance.listSchedules()).filter(
        (schedule) => schedule.callback === "pollWeChat",
      ).length;
    });
    expect(scheduled).toBe(0);

    // A direct callback invocation must not reach iLink either. The loop's
    // ownsRun check would also stop it after the route lookup, so count route
    // lookups to pin the entry guard specifically.
    let routeCalls = 0;
    await runInDurableObject(hub, (instance) => {
      const target = instance as unknown as {
        currentRoute(): Promise<unknown>;
      };
      const original = target.currentRoute.bind(instance);
      target.currentRoute = async () => {
        routeCalls += 1;
        return original();
      };
    });

    let calls = 0;
    setILinkFetchOverride((async () => {
      calls += 1;
      return jsonResponse({ get_updates_buf: "leased-cursor", msgs: [] });
    }) as typeof fetch);

    await runInDurableObject(hub, (instance) => instance.pollWeChat());

    expect(routeCalls).toBe(0);
    expect(calls).toBe(0);
    expect(await readWeChatState(hub)).toMatchObject({
      cursor: null,
      status: "running",
    });
  });

  it("stops a running WeChat poll loop once a lease is acquired", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    setPollTimingOverride({ runMs: 1000, baseBackoffMs: 1, manualStart: true });

    const hub = channels("maintenance-wechat-running");
    await hub.ensurePolling();
    await cancelSchedules(hub);

    let calls = 0;
    let release!: (response: Response) => void;
    setILinkFetchOverride((async () => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }) as typeof fetch);

    await runInDurableObject(hub, async (instance) => {
      const poll = instance.pollWeChat();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      await instance.acquireMaintenance("export", "op-running");
      release(
        jsonResponse({ get_updates_buf: "leased-cursor", msgs: [] }),
      );
      await poll;
    });

    expect(calls).toBe(1);
    expect(await readWeChatState(hub)).toMatchObject({
      cursor: null,
      status: "running",
    });
  });

  it("skips the cron while a lease is live", async () => {
    const stub = butler();
    let reconciled = 0;
    let original!: (routeKey: string) => Promise<void>;
    await runInDurableObject(stub, (instance) => {
      const proto = Object.getPrototypeOf(instance) as {
        reconcileChannel(routeKey: string): Promise<void>;
      };
      original = proto.reconcileChannel;
      proto.reconcileChannel = async () => {
        reconciled += 1;
      };
    });

    try {
      await worker.scheduled({} as ScheduledController, env);
      expect(reconciled).toBe(1);

      await stub.acquireMaintenance("export", "op-cron");
      await worker.scheduled({} as ScheduledController, env);
      expect(reconciled).toBe(1);
    } finally {
      await runInDurableObject(stub, (restored) => {
        (
          Object.getPrototypeOf(restored) as {
            reconcileChannel(routeKey: string): Promise<void>;
          }
        ).reconcileChannel = original;
      });
    }
  });
});
