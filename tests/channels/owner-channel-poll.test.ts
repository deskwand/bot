import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setILinkFetchOverride,
  setPollTimingOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import { ownerPrincipal } from "../../src/members/principal";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const CREDS = {
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "owner-account",
  userId: "owner-user",
  token: "token",
};

const ENV = env as unknown as Record<string, unknown>;
let savedChannel: unknown;

function channel(name: string) {
  const id = env.CHANNELS.idFromName(`${name}-${crypto.randomUUID()}`);
  return env.CHANNELS.get(id);
}

beforeEach(() => {
  setPollTimingOverride({ runMs: 0, baseBackoffMs: 1, manualStart: true });
  // The deployment's selected channel: this suite exercises the WeChat branch.
  savedChannel = ENV.ACTIVE_CHANNEL;
  ENV.ACTIVE_CHANNEL = "wechat";
});

afterEach(() => {
  if (savedChannel === undefined) delete ENV.ACTIVE_CHANNEL;
  else ENV.ACTIVE_CHANNEL = savedChannel;
  setPollTimingOverride(null);
  setWeChatCredentialsOverride(null);
  setILinkFetchOverride(null);
  vi.restoreAllMocks();
});

type Private = {
  ensurePolling(): Promise<void>;
  pollWeChat(): Promise<void>;
  sendToMember(actor: unknown, message: { text: string }): Promise<unknown>;
  listSchedules(): Promise<{ id: string; callback: string; payload: unknown }[]>;
};

describe("the first channel on the channel chain", () => {
  it("imports the deployment credential and retires the old chain", async () => {
    // Let the channel chain schedule its first poll: that is the point here.
    setPollTimingOverride({ runMs: 0, baseBackoffMs: 1 });
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    const hub = channel("owner-import");
    const outcome = await runInDurableObject(hub, async (instance, state) => {
      await (instance as unknown as Private).ensurePolling();

      const schedules = (await (instance as unknown as Private).listSchedules()).map(
        (schedule) => schedule.callback,
      );
      const connection = state.storage.sql
        .exec<{ id: string; member_id: string }>(
          `SELECT id, member_id FROM member_connections WHERE member_id = 'owner'`,
        )
        .toArray()[0];
      return { connection, schedules };
    });
    expect(outcome.connection?.member_id).toBe("owner");
    // One chain, and it is the channel chain: the deployment chain is retired.
    expect(outcome.schedules).toContain("pollMemberWeChat");
    expect(outcome.schedules).not.toContain("pollWeChat");
  });

  it("does not fetch through the retired chain", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    const fetches: string[] = [];
    setILinkFetchOverride((async (input: RequestInfo | URL) => {
      fetches.push(String(input));
      return new Response(JSON.stringify({ ret: 0, data: {} }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    const hub = channel("owner-retired-poll");
    await runInDurableObject(hub, async (instance) => {
      await (instance as unknown as Private).ensurePolling();
      await (instance as unknown as Private).pollWeChat();
    });
    // Two chains on one credential would answer every message twice.
    expect(fetches).toEqual([]);
  });

  it("defers the owner's poll while a maintenance lease is live", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    const fetches: string[] = [];
    setILinkFetchOverride((async (input: RequestInfo | URL) => {
      fetches.push(String(input));
      return new Response(JSON.stringify({ ret: 0, data: {} }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    const hub = channel("owner-lease");
    const deferred = await runInDurableObject(hub, async (instance, state) => {
      const api = instance as unknown as Private & {
        pollMemberWeChat(payload: { connectionId: string; generation: number }): Promise<void>;
        acquireMaintenance(kind: string, op: string): Promise<void>;
      };
      await api.ensurePolling();
      await api.acquireMaintenance("export", "op-1");
      const connection = state.storage.sql
        .exec<{ id: string; generation: number }>(
          `SELECT id, generation FROM member_connections WHERE member_id = 'owner'`,
        )
        .toArray()[0];
      await api.pollMemberWeChat({
        connectionId: connection?.id as string,
        generation: connection?.generation as number,
      });
      return state.storage.get<number>(`poll:defer:${connection?.id}:${connection?.generation}`);
    });
    // A live lease must stop the chain without losing the will to continue.
    expect(fetches).toEqual([]);
    expect(deferred).toBe(1);
  });

  it("queues a reply on the owner's own connection", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    const hub = channel("owner-send");
    const queued = await runInDurableObject(hub, async (instance, state) => {
      await (instance as unknown as Private).ensurePolling();
      await (instance as unknown as Private).sendToMember(ownerPrincipal(), {
        text: "hello",
      });
      return state.storage.sql
        .exec<{ c: number }>(`SELECT COUNT(*) AS c FROM outbound_queue`)
        .toArray()[0]?.c;
    });
    expect(queued).toBe(1);
  });
});
