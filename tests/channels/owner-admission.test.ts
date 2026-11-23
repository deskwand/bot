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

const ENV = env as unknown as Record<string, unknown>;
let saved: unknown;

const CREDS = {
  token: "tok",
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "acct",
  userId: "user",
};

beforeEach(() => {
  saved = ENV.ACTIVE_CHANNEL;
  ENV.ACTIVE_CHANNEL = "wechat";
  setPollTimingOverride({ runMs: 0, baseBackoffMs: 1, manualStart: true });
  setILinkFetchOverride((async () =>
    new Response(JSON.stringify({ ret: 0, data: {} }), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch);
});

afterEach(() => {
  if (saved === undefined) delete ENV.ACTIVE_CHANNEL;
  else ENV.ACTIVE_CHANNEL = saved;
  setPollTimingOverride(null);
  setWeChatCredentialsOverride(null);
  setILinkFetchOverride(null);
  vi.restoreAllMocks();
});

type Api = {
  ensurePolling(): Promise<void>;
  routeForMember(actor: unknown): Promise<{ channel: string | null; routeKey: string }>;
  isMemberAdmissionCurrent(
    actor: unknown,
    channel: string,
    ref: { memberId: string; connectionId: string; generation: number },
    routeKey: string,
  ): Promise<boolean>;
};

describe("owner admission on the channel chain", () => {
  it("accepts a ref for the owner connection", async () => {
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    const hub = env.CHANNELS.get(env.CHANNELS.idFromName(`adm-${crypto.randomUUID()}`));
    const outcome = await runInDurableObject(hub, async (instance, state) => {
      const api = instance as unknown as Api;
      await api.ensurePolling();
      const row = state.storage.sql
        .exec<{ id: string; generation: number; member_id: string }>(
          `SELECT id, generation, member_id FROM member_connections LIMIT 1`,
        )
        .toArray()[0];
      const route = await api.routeForMember(ownerPrincipal());
      const ref = {
        memberId: row?.member_id as string,
        connectionId: row?.id as string,
        generation: row?.generation as number,
      };
      const current = await api.isMemberAdmissionCurrent(
        ownerPrincipal(),
        "wechat",
        ref,
        route.routeKey,
      );
      return { route, ref, current };
    });
    expect(outcome.route.channel).toBe("wechat");
    expect(outcome.current).toBe(true);
  });
});
