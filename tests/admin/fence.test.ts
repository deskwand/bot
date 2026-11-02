import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { fakeChannel } from "../helpers/fake-channel";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function butler() {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

function task(id: string) {
  return env.TASK.get(env.TASK.idFromName(id));
}

function channels(name = "channels") {
  return env.CHANNELS.get(env.CHANNELS.idFromName(name));
}

beforeEach(() => {
  setChannelOverride("telegram", fakeChannel().adapter);
});

afterEach(async () => {
  setChannelOverride("telegram", null);
  await runInDurableObject(butler(), (_instance, state) => {
    state.storage.sql.exec(`DROP TABLE IF EXISTS admin_maintenance`);
  });
});

describe("maintenance lease fences direct writers", () => {
  it("rejects Butler reports while the lease is live and keeps events undelivered", async () => {
    const taskId = `t-fenced-report-${crypto.randomUUID()}`;

    await butler().acquireMaintenance("restore", "op-fence-report");
    const during = await runInDurableObject(butler(), async (instance, state) => {
      await expect(
        instance.report({ taskId, seq: 1, type: "started" }),
      ).rejects.toThrow(/maintenance/);
      return (
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?`,
            taskId,
          )
          .toArray()[0]?.count ?? 0
      );
    });
    expect(during).toBe(0);

    await butler().releaseMaintenance("op-fence-report");
    await butler().report({ taskId, seq: 1, type: "started" });
    const after = await butler().debugEvents(taskId);
    expect(after.map((event) => event.type)).toEqual(["started"]);
  });

  it("rejects inbound Butler messages while the lease is live", async () => {
    await butler().acquireMaintenance("restore", "op-fence-message");
    await runInDurableObject(butler(), async (instance) => {
      await expect(
        instance.handleMessage({
          type: "message",
          channel: "telegram",
          chatId: "1",
          userId: "1",
          text: "hello",
          eventId: "tg:fenced",
          routeKey: "route",
        }),
      ).rejects.toThrow(/maintenance/);
    });
    await butler().releaseMaintenance("op-fence-message");
  });

  it("defers Task startup without flushing, then resumes from the alarm", async () => {
    const taskId = `t-fenced-startup-${crypto.randomUUID()}`;
    const stub = task(taskId);
    await butler().acquireMaintenance("restore", "op-fence-startup");

    const deferred = await runInDurableObject(stub, async (instance, state) => {
      const target = instance as unknown as {
        setMeta(key: string, value: string): void;
        readMeta(key: string): string | undefined;
      };
      target.setMeta("task_id", taskId);
      target.setMeta("title", "fenced startup");
      state.storage.sql.exec(
        `INSERT INTO events (type, payload_json, delivered) VALUES ('started', '{"type":"started"}', 0)`,
      );
      await instance.onStart();
      return {
        deferred: target.readMeta("startup_deferred"),
        alarm: await state.storage.getAlarm(),
        undelivered: state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM events WHERE delivered = 0`,
          )
          .toArray()[0]?.count,
      };
    });

    expect(deferred.deferred).toBe("1");
    expect(deferred.alarm).not.toBeNull();
    expect(deferred.undelivered).toBe(1);
    expect(await butler().debugEvents(taskId)).toEqual([]);

    // Expire the lease and let the alarm retry the deferred startup.
    await runInDurableObject(butler(), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE admin_maintenance SET until = ?`,
        Date.now() - 1,
      );
    });
    const activeBefore = await butler().maintenanceActive();
    const resumed = await runInDurableObject(stub, async (instance, state) => {
      await instance.alarm();
      return {
        deferred: state.storage.sql
          .exec<{ value: string }>(
            `SELECT value FROM meta WHERE key = 'startup_deferred'`,
          )
          .toArray()[0]?.value,
        undelivered: state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM events WHERE delivered = 0`,
          )
          .toArray()[0]?.count,
      };
    });
    expect(resumed.deferred).toBe("0");
    expect(resumed.undelivered).toBe(0);
    expect((await butler().debugEvents(taskId)).map((event) => event.type)).toEqual([
      "started",
    ]);
  });

  it("refuses channel dispatch while the lease is live", async () => {
    const hub = channels("fence-dispatch");
    await hub.acquireMaintenance("restore", "op-fence-dispatch");

    const admitted = await runInDurableObject(hub, (instance) => {
      const target = instance as unknown as {
        dispatchMessage(event: unknown, routeKey: string): boolean;
      };
      return target.dispatchMessage(
        {
          type: "message",
          channel: "telegram",
          chatId: "1",
          userId: "1",
          text: "hello",
          eventId: "tg:fence-dispatch",
        },
        "route",
      );
    });

    expect(admitted).toBe(false);
    await hub.releaseMaintenance("op-fence-dispatch");
  });
});
