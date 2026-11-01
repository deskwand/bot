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

beforeEach(async () => {
  await seedOwnerAddress("42");
  route = await channels().currentRoute();
});

afterEach(() => {
  setChannelOverride("telegram", null);
  setModelOverride(null);
  vi.restoreAllMocks();
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

  it("does nothing when the schedule row is gone", async () => {
    const stub = butler("schedules-run-missing");
    await expect(
      stub.runSchedule({ scheduleId: "s404" }),
    ).resolves.toBeUndefined();
    expect(await taskRow(stub, "t1")).toBeUndefined();
  });
});
