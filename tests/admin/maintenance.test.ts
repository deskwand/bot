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
import worker from "../../src/index";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const OWNER = "wx-owner";

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

async function pollSchedules(hub: ReturnType<typeof channels>) {
  return runInDurableObject(hub, async (instance) =>
    (await instance.listSchedules()).filter(
      (schedule) => schedule.callback === "pollWeChat",
    ),
  );
}

async function cancelSchedules(hub: ReturnType<typeof channels>) {
  await runInDurableObject(hub, async (instance) => {
    for (const schedule of await instance.listSchedules()) {
      await instance.cancelSchedule(schedule.id);
    }
  });
}

beforeEach(() => {
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  setPollTimingOverride({ runMs: 0, baseBackoffMs: 1, manualStart: true });
  setWeChatCredentialsOverride(null);
});

afterEach(() => {
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  setILinkFetchOverride(null);
  setPollTimingOverride(null);
  setWeChatCredentialsOverride(null);
  restoreEnv();
  vi.restoreAllMocks();
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
  it("rejects the Telegram webhook while a lease is live", async () => {
    const hub = channels("maintenance-webhook");
    await hub.acquireMaintenance("export", "op-webhook");

    const request = new Request("https://example.com/telegram/webhook", {
      method: "POST",
    });

    await expect(hub.handleTelegramWebhook(request)).resolves.toBe(
      "maintenance",
    );
  });

  it("accepts the Telegram webhook again after the lease expires", async () => {
    const hub = channels("maintenance-webhook-expired");
    await hub.acquireMaintenance("export", "op-expired");
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE admin_maintenance SET until = ?`,
        Date.now() - 1,
      );
    });

    const request = new Request("https://example.com/telegram/webhook", {
      method: "POST",
    });

    await expect(hub.handleTelegramWebhook(request)).resolves.toBe("accepted");
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
    let calls = 0;
    setILinkFetchOverride((async () => {
      calls += 1;
      return jsonResponse({});
    }) as typeof fetch);

    const hub = channels("maintenance-wechat-idle");
    await hub.acquireMaintenance("export", "op-idle");
    await hub.ensurePolling();

    expect(calls).toBe(0);
    expect(await pollSchedules(hub)).toEqual([]);
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
      await stub.acquireMaintenance("export", "op-cron");
      await worker.scheduled({} as ScheduledController, env);
      expect(reconciled).toBe(0);
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
