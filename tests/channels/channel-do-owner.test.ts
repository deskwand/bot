import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import type { ChannelAdapter } from "../../src/channels/types";
import type { InboundEvent, MessageEvent } from "../../src/protocol";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

function setEnv(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!savedEnv.has(key)) savedEnv.set(key, ENV[key]);
    ENV[key] = value;
  }
}

/** 只抹掉 owner 键，其余配置原样保留。 */
function configWithoutOwner(): Record<string, unknown> {
  const base = { ...(ENV.DESKWAND_CONFIG as Record<string, unknown>) };
  delete base.owner;
  return base;
}

function withOwner(ids: number[]): Record<string, unknown> {
  return {
    ...(ENV.DESKWAND_CONFIG as Record<string, unknown>),
    owner: { telegramUserIds: ids },
  };
}

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("owner-gate"));
}

function claims() {
  return runInDurableObject(channels(), (_instance, state) =>
    state.storage.sql
      .exec<{ owner_user_id: string | null; window_opened_at: number }>(
        `SELECT owner_user_id, window_opened_at FROM channel_claims`,
      )
      .toArray(),
  );
}

async function harness() {
  const sent: string[] = [];
  const dispatched: MessageEvent[] = [];

  const adapter: ChannelAdapter = {
    async parseInbound(update) {
      return update as InboundEvent;
    },
    async send(_to, msg) {
      sent.push(msg.text);
      return { messageId: "1" };
    },
    async edit() {},
    async sendArtifact() {},
    async answerAction() {},
  };
  setChannelOverride("telegram", adapter);

  const butler = env.BUTLER.get(env.BUTLER.idFromName("owner"));
  await runInDurableObject(butler, (instance) => {
    const proto = Object.getPrototypeOf(instance) as {
      handleMessage(evt: MessageEvent): Promise<void>;
    };
    proto.handleMessage = async (evt) => {
      dispatched.push(evt);
    };
  });

  const stub = channels();
  return {
    sent,
    dispatched,
    send: (event: InboundEvent) => stub.handleTelegramUpdate(event),
  };
}

function message(userId: string, text = "hi"): InboundEvent {
  return {
    type: "message",
    channel: "telegram",
    chatId: userId,
    userId,
    text,
    eventId: `tg:${userId}:${text}`,
  } as InboundEvent;
}

async function reset(): Promise<void> {
  await runInDurableObject(channels(), (_instance, state) => {
    for (const table of ["channel_claims", "owner_addresses"]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
}

afterEach(() => {
  setChannelOverride("telegram", null);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete ENV[key];
    else ENV[key] = value;
  }
  savedEnv.clear();
});

describe("telegram 认领门禁", () => {
  it("缺省 owner：第一个人被认领、收到回执、消息照常进管家", async () => {
    setEnv({ DESKWAND_CONFIG: configWithoutOwner() });
    await reset();
    const h = await harness();
    await h.send(message("111111"));

    expect(await claims()).toEqual([
      { owner_user_id: "111111", window_opened_at: expect.any(Number) },
    ]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("111111");
    // dispatchMessage 走 ctx.waitUntil，所以分发是异步的。
    await vi.waitFor(() => {
      expect(h.dispatched.map((event) => event.userId)).toEqual(["111111"]);
    });
  });

  it("认领后再来的人被静默忽略，也不进管家", async () => {
    setEnv({ DESKWAND_CONFIG: configWithoutOwner() });
    await reset();
    const h = await harness();
    await h.send(message("111111"));
    await vi.waitFor(() => {
      expect(h.dispatched).toHaveLength(1);
    });
    await h.send(message("999999"));

    expect(h.sent).toHaveLength(1);
    expect(h.dispatched).toHaveLength(1);
  });

  it("静态名单非空：不认领、不回执、不写表", async () => {
    setEnv({ DESKWAND_CONFIG: withOwner([111111]) });
    await reset();
    const h = await harness();
    await h.send(message("999999"));

    expect(await claims()).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.dispatched).toEqual([]);
  });

  it("空数组：硬关闭，第一个人也不会被认领", async () => {
    setEnv({ DESKWAND_CONFIG: withOwner([]) });
    await reset();
    const h = await harness();
    await h.send(message("999999"));

    expect(await claims()).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("窗口过期后不再认领", async () => {
    setEnv({ DESKWAND_CONFIG: configWithoutOwner() });
    await reset();
    await runInDurableObject(channels(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO channel_claims (channel, owner_user_id, claimed_at, window_opened_at, updated_at)
         VALUES ('telegram', NULL, NULL, 1, 1)`,
      );
    });
    const h = await harness();
    await h.send(message("999999"));

    expect(await claims()).toEqual([
      { owner_user_id: null, window_opened_at: 1 },
    ]);
    expect(h.sent).toEqual([]);
  });

  it("静态模式下 revoke/open 是空操作", async () => {
    setEnv({ DESKWAND_CONFIG: withOwner([111111]) });
    await reset();
    const stub = channels();
    expect((await stub.revokeOwner()).mode).toBe("static");
    expect((await stub.openOwnerClaim()).mode).toBe("static");
    expect(await claims()).toEqual([]);
  });

  it("缺省模式下 revoke 清掉主人并关闭窗口", async () => {
    setEnv({ DESKWAND_CONFIG: configWithoutOwner() });
    await reset();
    const h = await harness();
    await h.send(message("111111"));

    const status = await channels().revokeOwner();
    expect(status.mode).toBe("closed");
    expect(status.ownerUserId).toBeNull();
    expect(await claims()).toEqual([
      { owner_user_id: null, window_opened_at: 0 },
    ]);
  });
});
