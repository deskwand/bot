import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ButlerDO } from "../../src/butler/butler-do";
import { InvalidCronError, ScheduleStore } from "../../src/butler/schedules";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import type { AdmittedMessage, RouteSnapshot } from "../../src/protocol";
import { fakeChannel } from "../helpers/fake-channel";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

let route: RouteSnapshot;

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

/** Builds an independent env fixture for the next ChannelDO instance. */
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

beforeEach(async () => {
  await seedOwnerAddress("42");
  route = await channels().currentRoute();
});

afterEach(() => {
  setChannelOverride("telegram", null);
  setModelOverride(null);
  vi.restoreAllMocks();
  restoreEnv();
});

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

function message(evt: { text: string; eventId: string }): AdmittedMessage {
  return {
    type: "message",
    channel: "telegram",
    chatId: "42",
    userId: "1",
    ...evt,
    routeKey: route.routeKey,
  };
}

async function runTool(
  instance: ButlerDO,
  name: string,
  args: unknown,
): Promise<string> {
  const entry = instance.registry
    .snapshot()
    .tools()
    .find(({ tool }) => tool.name === name);
  if (!entry) throw new Error(`missing tool ${name}`);
  const outcome = await entry.tool.execute(
    args as never,
    {} as never,
    {} as never,
  );
  return (outcome.output?.[0] as { text: string }).text;
}

async function taskRow(
  stub: ReturnType<typeof butler>,
  id: string,
): Promise<
  { id: string; title: string; status: string; chat_id: string | null }
  | undefined
> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{
        id: string;
        title: string;
        status: string;
        chat_id: string | null;
      }>(`SELECT id, title, status, chat_id FROM tasks WHERE id = ?`, id)
      .toArray()[0],
  );
}

describe("ScheduleStore", () => {
  it("stores schedules with increasing ids and persists the agent schedule id", async () => {
    const result = await runInDurableObject(
      butler("schedules-store"),
      (_instance, state) => {
        const store = new ScheduleStore(state.storage.sql);
        const first = store.add("0 1 * * *", "每天汇总新闻", "汇总新闻", "42");
        const second = store.add("*/30 * * * *", "提醒我喝水", "提醒喝水", null);
        store.setAgentScheduleId(first, "agent-job-1");
        return {
          first,
          second,
          removed: store.remove(second),
          missing: store.remove("s99"),
          list: store.list(),
        };
      },
    );

    expect(result.first).toBe("s1");
    expect(result.second).toBe("s2");
    expect(result.removed).toBe(true);
    expect(result.missing).toBe(false);
    expect(result.list).toEqual([
      {
        id: "s1",
        cron: "0 1 * * *",
        title: "汇总新闻",
        instructions: "每天汇总新闻",
        chatId: "42",
        agentScheduleId: "agent-job-1",
        createdAt: expect.any(Number),
        at: null,
      },
    ]);
  });

  it("adds a one-shot row to a table that predates the at column", async () => {
    const result = await runInDurableObject(
      butler("schedules-store-once"),
      (_instance, state) => {
        // An object created before one-shot schedules has no `at` column.
        state.storage.sql.exec(`DROP TABLE schedules`);
        state.storage.sql.exec(`DROP TABLE schedules_meta`);
        state.storage.sql.exec(
          `CREATE TABLE schedules (
            id TEXT PRIMARY KEY,
            cron TEXT NOT NULL,
            title TEXT NOT NULL,
            instructions TEXT NOT NULL,
            chat_id TEXT,
            agent_schedule_id TEXT,
            created_at INTEGER NOT NULL
          )`,
        );
        state.storage.sql.exec(
          `CREATE TABLE schedules_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        );
        state.storage.sql.exec(
          `INSERT INTO schedules_meta VALUES ('schedule_counter', '1')`,
        );
        state.storage.sql.exec(
          `INSERT INTO schedules VALUES ('s1', '0 1 * * *', '旧任务', '旧内容', NULL, 'job-1', 1)`,
        );

        const store = new ScheduleStore(state.storage.sql);
        const once = store.addOnce(1_800_000_000_000, "交材料", "提醒交材料", null);
        return { once, list: store.list() };
      },
    );

    expect(result.once).toBe("s2");
    expect(result.list).toEqual([
      {
        id: "s1",
        cron: "0 1 * * *",
        title: "旧任务",
        instructions: "旧内容",
        chatId: null,
        agentScheduleId: "job-1",
        createdAt: 1,
        at: null,
      },
      {
        id: "s2",
        cron: "",
        title: "提醒交材料",
        instructions: "交材料",
        chatId: null,
        agentScheduleId: null,
        createdAt: expect.any(Number),
        at: 1_800_000_000_000,
      },
    ]);
  });

  it("rejects an invalid cron before saving", async () => {
    await expect(
      runInDurableObject(butler("schedules-store-invalid"), (_instance, state) => {
        new ScheduleStore(state.storage.sql).add("bad", "x", "y", null);
      }),
    ).rejects.toBeInstanceOf(InvalidCronError);
  });
});

describe("butler schedule tools", () => {
  it("creates and removes an Agent schedule", async () => {
    const result = await runInDurableObject(
      butler("schedules-unschedule"),
      async (instance) => {
        const created = await runTool(instance, "schedule", {
          cron: "0 1 * * *",
          title: "每日早报",
          instructions: "汇总今天的新闻",
        });
        const scheduled = await instance.listSchedules();
        const removed = await runTool(instance, "unschedule", { id: "s1" });
        const remaining = await instance.listSchedules();
        const missing = await runTool(instance, "unschedule", { id: "s1" });
        return { created, scheduled, removed, remaining, missing };
      },
    );

    expect(result.created).toBe("已创建定时任务 s1");
    expect(result.scheduled).toHaveLength(1);
    expect(result.scheduled[0]).toMatchObject({
      callback: "runSchedule",
      cron: "0 1 * * *",
    });
    expect(result.removed).toBe("已删除定时任务 s1");
    expect(result.remaining).toHaveLength(0);
    expect(result.missing).toBe("没有定时任务 s1");
  });

  it("lists schedules as id, cron and title", async () => {
    const result = await runInDurableObject(
      butler("schedules-list"),
      async (instance) => {
        const empty = await runTool(instance, "list_schedules", {});
        await runTool(instance, "schedule", {
          cron: "0 1 * * *",
          title: "每日早报",
          instructions: "汇总新闻",
        });
        const listed = await runTool(instance, "list_schedules", {});
        return { empty, listed };
      },
    );

    expect(result.empty).toBe("没有定时任务");
    expect(result.listed).toBe("s1 0 1 * * * 每日早报");
  });

  it("creates a one-shot schedule and lists its time instead of a cron", async () => {
    const result = await runInDurableObject(
      butler("schedules-once"),
      async (instance) => {
        const before = Date.now();
        const created = await runTool(instance, "schedule", {
          after: "2h",
          title: "交材料",
          instructions: "提醒主人交材料",
        });
        return {
          before,
          created,
          listed: await runTool(instance, "list_schedules", {}),
          scheduled: await instance.listSchedules(),
        };
      },
    );

    expect(result.created).toMatch(/^已创建定时任务 s1（.+Z，北京时间 .+）$/);
    // A Date schedules a one-shot callback; a number would mean a delay.
    expect(result.scheduled[0]).toMatchObject({
      callback: "runSchedule",
      type: "scheduled",
    });

    const match = /^s1 (\S+) 交材料$/.exec(result.listed);
    expect(match).not.toBeNull();
    const at = Date.parse(match![1]!);
    expect(at).toBeGreaterThanOrEqual(result.before + 7_200_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 7_200_000);
  });

  it("converts an at with an offset to the stated instant", async () => {
    const result = await runInDurableObject(
      butler("schedules-once-at"),
      async (instance) => ({
        created: await runTool(instance, "schedule", {
          at: "2030-03-01T10:00:00+08:00",
          title: "交材料",
          instructions: "提醒主人交材料",
        }),
        listed: await runTool(instance, "list_schedules", {}),
      }),
    );

    expect(result.created).toBe(
      "已创建定时任务 s1（2030-03-01T02:00:00.000Z，北京时间 2030-03-01 10:00）",
    );
    expect(result.listed).toBe("s1 2030-03-01T02:00:00.000Z 交材料");
  });

  it("rejects anything but exactly one of cron, after and at", async () => {
    const result = await runInDurableObject(
      butler("schedules-once-args"),
      async (instance) => {
        const ask = (args: Record<string, unknown>) =>
          runTool(instance, "schedule", {
            title: "x",
            instructions: "y",
            ...args,
          });
        return {
          none: await ask({}),
          two: await ask({ cron: "0 1 * * *", after: "1h" }),
          badAfter: await ask({ after: "soon" }),
          badAt: await ask({ at: "明天" }),
          zoneMissing: await ask({ at: "2030-03-01T10:00" }),
          past: await ask({ at: "2020-01-01T00:00:00Z" }),
          rows: (await instance.listSchedules()).length,
        };
      },
    );

    expect(result.none).toBe("cron、after、at 三选一");
    expect(result.two).toBe("cron、after、at 三选一");
    expect(result.badAfter).toBe("时长格式无效：soon（示例：30m、2h、1d）");
    expect(result.badAt).toBe("时间格式无效：明天");
    // Without an offset the string would parse as local time and land 8 hours off.
    expect(result.zoneMissing).toContain("时间必须带时区偏移：2030-03-01T10:00");
    expect(result.past).toContain("时间已过去：2020-01-01T00:00:00.000Z");
    expect(result.rows).toBe(0);
  });

  it("returns 没有定时任务 for unknown schedule ids", async () => {
    const text = await runInDurableObject(
      butler("schedules-unschedule-unknown"),
      (instance) => runTool(instance, "unschedule", { id: "s9" }),
    );
    expect(text).toBe("没有定时任务 s9");
  });

  it("rejects invalid cron expressions and keeps no schedule", async () => {
    const result = await runInDurableObject(
      butler("schedules-invalid"),
      async (instance, state) => {
        const bad = await runTool(instance, "schedule", {
          cron: "bad",
          title: "x",
          instructions: "y",
        });
        const outOfRange = await runTool(instance, "schedule", {
          cron: "61 * * * *",
          title: "x",
          instructions: "y",
        });
        return {
          bad,
          outOfRange,
          scheduled: await instance.listSchedules(),
          rows: new ScheduleStore(state.storage.sql).list(),
        };
      },
    );

    expect(result.bad).toBe("cron 表达式无效：bad");
    expect(result.outOfRange).toBe("cron 表达式无效：61 * * * *");
    expect(result.scheduled).toHaveLength(0);
    expect(result.rows).toHaveLength(0);
  });
});

describe("ButlerDO.runSchedule", () => {
  it("runs a cron callback on the same lifecycle as the harness", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ text: "管家在" }]));

    const stub = butler("schedules-run");
    const created = await runInDurableObject(stub, async (instance) => {
      const text = await runTool(instance, "schedule", {
        cron: "0 1 * * *",
        title: "每日早报",
        instructions: "汇总今天的新闻",
      });
      return { text, scheduled: await instance.listSchedules() };
    });
    expect(created.text).toBe("已创建定时任务 s1");
    expect(created.scheduled[0]).toMatchObject({ callback: "runSchedule" });

    // A cron registered through Agent.schedule shares the Lifecycle alarm with
    // the Pi harness: the Butler still answers messages.
    await stub.handleMessage(message({ text: "你好", eventId: "tg:501" }));
    expect(channel.sent.at(-1)).toEqual({ chatId: "42", text: "管家在" });

    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
      ]),
    );
    await stub.runSchedule({ scheduleId: "s1" });

    const taskStub = env.TASK.get(env.TASK.idFromName("t1"));
    await vi.waitFor(
      async () => {
        expect((await taskStub.status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );
    expect(await taskRow(stub, "t1")).toMatchObject({
      id: "t1",
      title: "每日早报",
      chat_id: null,
    });
  }, 20_000);

  it("does not spawn a task while the channel selection is disabled", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const stub = butler("schedules-run-disabled");
    await runInDurableObject(stub, (_instance, state) => {
      new ScheduleStore(state.storage.sql).add(
        "0 1 * * *",
        "每日早报",
        "汇总新闻",
        null,
      );
    });

    // A typo in ACTIVE_CHANNEL disables I/O. Results would be swallowed, so a
    // cron must not burn model tokens by spawning a task nobody hears about.
    setEnv({ ACTIVE_CHANNEL: "wechat " });
    await runInDurableObject(stub, (instance) => {
      // A fresh ChannelDO resolves the route from the mutated environment;
      // the shared one cached its route earlier in the run.
      (instance as unknown as { channels(): unknown }).channels = () =>
        env.CHANNELS.get(
          env.CHANNELS.idFromName("schedules-run-disabled-hub"),
        );
    });

    await stub.runSchedule({ scheduleId: "s1" });

    expect(await taskRow(stub, "t1")).toBeUndefined();
    const counts = await runInDurableObject(stub, (_instance, state) => ({
      tasks: state.storage.sql
        .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM tasks`)
        .toArray()[0]?.count,
      events: state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM task_events`,
        )
        .toArray()[0]?.count,
    }));
    expect(counts).toEqual({ tasks: 0, events: 0 });

    // The owner is told once why the schedule did nothing.
    expect(
      error.mock.calls.some(([message]) =>
        String(message).includes("s1"),
      ),
    ).toBe(true);
  }, 20_000);

  it("fires a one-shot once and drops its row", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
      ]),
    );

    const stub = butler("schedules-once-run");
    const created = await runInDurableObject(stub, (instance) =>
      runTool(instance, "schedule", {
        after: "2h",
        title: "交材料",
        instructions: "提醒主人交材料",
      }),
    );
    expect(created).toMatch(/^已创建定时任务 s1（.+）/);

    // The alarm fires the callback once; the schedule has no second chance at
    // running, so the row is gone before anything can skip it.
    await stub.runSchedule({ scheduleId: "s1" });

    expect(await taskRow(stub, "t1")).toMatchObject({
      id: "t1",
      title: "交材料",
    });
    const listed = await runInDurableObject(stub, (instance) =>
      runTool(instance, "list_schedules", {}),
    );
    expect(listed).toBe("没有定时任务");
  }, 20_000);

  it("drops a one-shot row even when the channel selection is disabled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const stub = butler("schedules-once-disabled");
    await runInDurableObject(stub, (_instance, state) => {
      new ScheduleStore(state.storage.sql).addOnce(
        Date.now() + 7_200_000,
        "提醒主人交材料",
        "交材料",
        null,
      );
    });

    setEnv({ ACTIVE_CHANNEL: "wechat " });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { channels(): unknown }).channels = () =>
        env.CHANNELS.get(
          env.CHANNELS.idFromName("schedules-once-disabled-hub"),
        );
    });

    await stub.runSchedule({ scheduleId: "s1", once: true });

    // Nothing ran, but a one-shot never gets a second alarm: leaving the row
    // would list a reminder that can never fire again.
    expect(await taskRow(stub, "t1")).toBeUndefined();
    const listed = await runInDurableObject(stub, (instance) =>
      runTool(instance, "list_schedules", {}),
    );
    expect(listed).toBe("没有定时任务");
  }, 20_000);

  it("exposes the current time to the butler", async () => {
    const names = await runInDurableObject(butler("schedules-now"), (instance) =>
      instance.registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name),
    );
    expect(names).toContain("now");
  });

  it("does nothing when the schedule row is gone", async () => {
    const stub = butler("schedules-run-missing");
    await expect(
      stub.runSchedule({ scheduleId: "s404" }),
    ).resolves.toBeUndefined();
    expect(await taskRow(stub, "t1")).toBeUndefined();
  });
});
