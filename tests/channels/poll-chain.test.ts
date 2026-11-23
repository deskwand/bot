import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelDO } from "../../src/channels/channel-do";
import {
  setILinkFetchOverride,
  setPollTimingOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import { ownerPrincipal } from "../../src/members/principal";

const credentials = {
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "owner-account",
  userId: "owner-user",
  token: "token",
};
const timing = { runMs: 0, baseBackoffMs: 1 };
const runtime = env as unknown as Record<string, unknown>;
let oldChannel: unknown;

type Ref = { connectionId: string; generation: number };
type Schedule = { id: string; callback: string; time: number; payload: Ref };
type Jobs = {
  listSchedules(): Promise<Schedule[]>;
  cancelSchedule(id: string): Promise<boolean>;
  schedule(delay: number, callback: string, payload: Ref): Promise<unknown>;
  loadMemberCredentials(id: string, generation: number): Promise<typeof credentials | null>;
  assertWritable(): Promise<void>;
  dispatchMessage(...args: unknown[]): boolean;
};

beforeEach(() => {
  oldChannel = runtime.ACTIVE_CHANNEL;
  runtime.ACTIVE_CHANNEL = "wechat";
  setWeChatCredentialsOverride(JSON.stringify(credentials));
  setPollTimingOverride({ ...timing, manualStart: true });
});

afterEach(() => {
  if (oldChannel === undefined) delete runtime.ACTIVE_CHANNEL;
  else runtime.ACTIVE_CHANNEL = oldChannel;
  setWeChatCredentialsOverride(null);
  setPollTimingOverride(null);
  setILinkFetchOverride(null);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function reply(cursor: string): Response {
  return Response.json({ get_updates_buf: cursor, msgs: [] });
}

async function withChain(
  check: (context: {
    hub: ChannelDO;
    jobs: Jobs;
    state: DurableObjectState;
    ref: Ref;
    polls: () => Promise<Schedule[]>;
  }) => Promise<void>,
): Promise<void> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(`poll-chain-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (hub, state) => {
    const jobs = hub as unknown as Jobs;
    await hub.ensurePolling();
    const [ref] = state.storage.sql.exec<Ref>(
      `SELECT id AS connectionId, generation FROM member_connections WHERE member_id = 'owner'`,
    ).toArray();
    if (!ref) throw new Error("owner connection missing");
    const polls = async () => (await jobs.listSchedules()).filter(
      (job) => job.callback === "pollMemberWeChat",
    );
    jobs.loadMemberCredentials = async () => credentials;
    setPollTimingOverride(timing);
    try {
      await jobs.schedule(0, "pollMemberWeChat", ref);
      // Drive the real job dispatcher in this request, not via the standby alarm.
      await check({ hub, jobs, state, ref, polls });
    } finally {
      for (const job of await polls()) await jobs.cancelSchedule(job.id);
      await state.storage.deleteAlarm();
    }
  });
}

describe("WeChat poll continuation", () => {
  it("leaves a distinct successor that actually fetches with the saved cursor", async () => {
    const cursors: string[] = [];
    setILinkFetchOverride(async (_url, init) => {
      cursors.push(JSON.parse(String(init?.body)).get_updates_buf);
      return reply(`cursor-${cursors.length}`);
    });
    await withChain(async ({ hub, ref, polls, state }) => {
      const [first] = await polls();
      expect(await state.storage.getAlarm()).not.toBeNull();
      await state.storage.deleteAlarm();
      await hub.alarm();
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(cursors).toEqual([""]);
      const next = await polls();
      expect(next).toHaveLength(1);
      expect(next[0]?.id).not.toBe(first?.id);
      expect(next[0]?.payload).toEqual(ref);
      await hub.alarm();
      expect(cursors).toEqual(["", "cursor-1"]);
      expect(await polls()).toHaveLength(1);
    });
  });

  it("leaves a delayed successor when credentials are temporarily unavailable", async () => {
    const cursors: string[] = [];
    setILinkFetchOverride(async (_url, init) => {
      cursors.push(JSON.parse(String(init?.body)).get_updates_buf);
      return reply("recovered");
    });
    await withChain(async ({ hub, jobs, state, ref, polls }) => {
      const load = jobs.loadMemberCredentials;
      jobs.loadMemberCredentials = async () => null;
      const [first] = await polls();
      await hub.alarm();
      const next = await polls();
      expect(next).toHaveLength(1);
      expect(next[0]?.id).not.toBe(first?.id);
      expect(next[0]?.time).toBeGreaterThan(first!.time);
      expect(cursors).toEqual([]);
      expect(await state.storage.get(`poll:defer:${ref.connectionId}:${ref.generation}`)).toBe(1);
      jobs.loadMemberCredentials = load;
      state.storage.sql.exec("UPDATE cf_agents_jobs SET time = 0 WHERE id = ?", next[0]!.id);
      await hub.alarm();
      expect(cursors).toEqual([""]);
      expect(await polls()).toHaveLength(1);
    });
  });

  it.each([false, true])("does not let a replaced poll requeue (fetch fails: %s)", async (fails) => {
    const started = deferred<void>();
    const fetchResult = deferred<Response>();
    setILinkFetchOverride(async () => {
      started.resolve();
      return fetchResult.promise;
    });
    await withChain(async ({ hub, state, ref, polls }) => {
      const old = hub.alarm();
      const outcome = await Promise.race([started.promise.then(() => "started"), old.then(() => "finished")]);
      expect(outcome).toBe("started");
      try {
        await hub.restartChannel(ownerPrincipal(), "owner");
        const replacement = await polls();
        expect(replacement).toHaveLength(1);
        if (fails) fetchResult.reject(new Error("old fetch failed"));
        else fetchResult.resolve(reply("stale"));
        await old;
        expect(await polls()).toEqual(replacement);
        expect(await state.storage.get(`poll:defer:${ref.connectionId}:${ref.generation}`)).toBeUndefined();
        expect(state.storage.sql.exec<{ cursor: string }>(
          "SELECT cursor FROM member_connections WHERE id = ?", ref.connectionId,
        ).one().cursor).toBe("");
      } finally {
        fetchResult.resolve(reply("stale"));
        await old;
      }
    });
  });

  it("continues after a transient iLink failure", async () => {
    let requests = 0;
    setILinkFetchOverride(async () => ++requests === 1
      ? new Response("unavailable", { status: 503 })
      : reply("recovered"));
    await withChain(async ({ hub, polls }) => {
      const [first] = await polls();
      await hub.alarm();
      const next = await polls();
      expect(requests).toBe(1);
      expect(next).toHaveLength(1);
      expect(next[0]?.id).not.toBe(first?.id);
      await hub.alarm();
      expect(requests).toBe(2);
      expect(await polls()).toHaveLength(1);
    });
  });

  it("does not requeue a poll replaced during iLink backoff", async () => {
    setILinkFetchOverride(async () => new Response("unavailable", { status: 503 }));
    await withChain(async ({ hub, ref, polls }) => {
      setPollTimingOverride({ ...timing, baseBackoffMs: 100 });
      const backoff = (hub as unknown as {
        memberWeChatBackoffMs: Map<string, number>;
      }).memberWeChatBackoffMs;
      const waiting = deferred<void>();
      const get = backoff.get;
      backoff.get = (id) => {
        waiting.resolve();
        return get.call(backoff, id);
      };
      const old = hub.alarm();
      try {
        expect(await Promise.race([waiting.promise.then(() => true), old.then(() => false)])).toBe(true);
        await hub.restartChannel(ownerPrincipal(), "owner");
        const replacement = await polls();
        expect(replacement).toHaveLength(1);
        await old;
        expect(await polls()).toEqual(replacement);
        expect(backoff.has(ref.connectionId)).toBe(false);
      } finally {
        backoff.get = get;
        await old;
      }
    });
  });

  it("serializes restart with a successor already being scheduled", async () => {
    setILinkFetchOverride(async () => reply("committed"));
    await withChain(async ({ hub, jobs, ref, polls }) => {
      const [original] = await polls();
      // A different connection's queued poll must survive this restart.
      await jobs.schedule(60, "pollMemberWeChat", { ...ref, connectionId: "other" });
      const atSchedule = deferred<void>();
      const resume = deferred<void>();
      const schedule = jobs.schedule;
      jobs.schedule = async (...args) => {
        atSchedule.resolve();
        await resume.promise;
        return schedule.apply(hub, args);
      };
      const poll = hub.alarm();
      const restartReady = deferred<void>();
      const assertWritable = jobs.assertWritable;
      let restart: Promise<void> | undefined;
      try {
        expect(await Promise.race([atSchedule.promise.then(() => true), poll.then(() => false)])).toBe(true);
        jobs.assertWritable = async () => {
          await assertWritable.call(hub);
          restartReady.resolve();
        };
        restart = hub.restartChannel(ownerPrincipal(), "owner");
        await Promise.race([restartReady.promise, restart]);
      } finally {
        resume.resolve();
        await Promise.all([poll, restart]);
        jobs.schedule = schedule;
        jobs.assertWritable = assertWritable;
      }
      const queued = await polls();
      const ours = queued.filter((job) => job.payload.connectionId === ref.connectionId);
      expect(ours).toHaveLength(1);
      expect(ours[0]?.id).not.toBe(original?.id);
      expect(queued.filter((job) => job.payload.connectionId === "other")).toHaveLength(1);
    });
  });

  it("does not defer a poll from a retired credential generation", async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    setILinkFetchOverride(async () => {
      started.resolve();
      return response.promise;
    });
    await withChain(async ({ hub, state, ref, polls }) => {
      const old = hub.alarm();
      try {
        expect(await Promise.race([started.promise.then(() => true), old.then(() => false)])).toBe(true);
        state.storage.sql.exec(
          "UPDATE member_connections SET generation = generation + 1 WHERE id = ?",
          ref.connectionId,
        );
      } finally {
        response.resolve(reply("stale"));
        await old;
      }
      expect(await polls()).toEqual([]);
      expect(await state.storage.get(`poll:defer:${ref.connectionId}:${ref.generation}`)).toBeUndefined();
    });
  });

  it("does not dispatch a nonempty batch after restart invalidates its admission", async () => {
    setILinkFetchOverride(async () => Response.json({
      get_updates_buf: "stale",
      msgs: [{ message_type: 1, from_user_id: credentials.userId,
        item_list: [{ type: 1, text_item: { text: "stale message" } }] }],
    }));
    await withChain(async ({ hub, jobs, polls }) => {
      const admitted = deferred<void>();
      const resume = deferred<void>();
      const admission = hub.isMemberAdmissionCurrent;
      let checks = 0;
      let dispatched = 0;
      jobs.dispatchMessage = () => { dispatched++; return true; };
      hub.isMemberAdmissionCurrent = async (...args) => {
        const allowed = await admission.apply(hub, args);
        if (++checks === 3) {
          admitted.resolve();
          await resume.promise;
        }
        return allowed;
      };
      const old = hub.alarm();
      try {
        expect(await Promise.race([admitted.promise.then(() => true), old.then(() => false)])).toBe(true);
        await hub.restartChannel(ownerPrincipal(), "owner");
      } finally {
        resume.resolve();
        await old;
      }
      expect(dispatched).toBe(0);
      expect(await polls()).toHaveLength(1);
    });
  });

  it("leaves the same job pending without polling during maintenance", async () => {
    let requests = 0;
    setILinkFetchOverride(async () => { requests++; return reply("unexpected"); });
    await withChain(async ({ hub, polls, state, ref }) => {
      const before = await polls();
      const current = await hub.getScheduleById(before[0]!.id);
      await hub.acquireMaintenance("export", "poll-chain-test");
      await hub.alarm();
      expect(await polls()).toEqual(before);
      // Model an alarm that passed the outer lease check before the lease landed.
      await hub.pollMemberWeChat(ref, current);
      const delayed = (await polls()).filter((job) => job.id !== before[0]!.id);
      expect(delayed).toHaveLength(1);
      expect(delayed[0]!.time).toBeGreaterThan(before[0]!.time);
      expect(await state.storage.get(`poll:defer:${ref.connectionId}:${ref.generation}`)).toBe(1);
      expect(requests).toBe(0);
    });
  });
});
