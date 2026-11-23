import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ownerPrincipal } from "../../src/members/principal";
import { MemberError } from "../../src/members/store";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function channel(name: string) {
  return env.CHANNELS.get(env.CHANNELS.idFromName(`${name}-${crypto.randomUUID()}`));
}

type Lifecycle = {
  createMemberInvite(actor: unknown, label: string): Promise<{ inviteId: string }>;
  removeChannel(actor: unknown, channelId: string): Promise<void>;
  restartChannel(actor: unknown, channelId: string): Promise<void>;
  completeInviteForTest(channelId: string, userId: string): void;
};

/** Seeds one bound channel with a connection, a context and a queue row. */
function seedBoundChannel(sql: SqlStorage, channelId: string, userId: string): void {
  sql.exec(
    `INSERT INTO members (id, label, role, status, epoch)
     VALUES (?, 'chan', 'member', 'active', 1)`,
    channelId,
  );
  sql.exec(
    `INSERT INTO member_connections
       (id, member_id, account_id, user_id, credential_key, credentials_hash,
        generation, status, cursor, conversation_id, poll_status)
     VALUES (?, ?, ?, ?, 'cred', 'hash', 1, 'active', 'cur', ?, 'polling')`,
    `conn-${channelId}`,
    channelId,
    `acct-${channelId}`,
    userId,
    userId,
  );
  sql.exec(
    `INSERT INTO outbound_queue (connection_id, generation, conversation_id, text, created_at)
     VALUES (?, 1, ?, 'pending', ?)`,
    `conn-${channelId}`,
    userId,
    Date.now(),
  );
}

describe("channel lifecycle", () => {
  it("removes a channel, frees its account, and lets it be added again", async () => {
    const hub = channel("lifecycle-remove");
    const outcome = await runInDurableObject(hub, async (instance, state) => {
      const sql = state.storage.sql;
      const api = instance as unknown as Lifecycle;
      seedBoundChannel(sql, "m-remove", "user-remove@im.wechat");
      await api.removeChannel(ownerPrincipal(), "m-remove");
      return {
        members: sql.exec(`SELECT COUNT(*) AS c FROM members WHERE id = 'm-remove'`).toArray()[0],
        connections: sql
          .exec(`SELECT COUNT(*) AS c FROM member_connections WHERE member_id = 'm-remove'`)
          .toArray()[0],
        queue: sql
          .exec(`SELECT COUNT(*) AS c FROM outbound_queue WHERE connection_id = 'conn-m-remove'`)
          .toArray()[0],
      };
    });
    expect(outcome.members?.c).toBe(0);
    // The connection row must really be gone: a retired row would keep the
    // account's unique index occupied and block re-adding forever.
    expect(outcome.connections?.c).toBe(0);
    expect(outcome.queue?.c).toBe(0);
  });

  it("refuses to remove the first channel", async () => {
    const hub = channel("lifecycle-owner");
    const error = await runInDurableObject(hub, async (instance) => {
      const api = instance as unknown as Lifecycle;
      return await api
        .removeChannel(ownerPrincipal(), "owner")
        .catch((caught: unknown) => caught);
    });
    expect(error).toBeInstanceOf(MemberError);
    expect((error as MemberError).code).toBe("OWNER_IMMUTABLE");
  });

  it("restarts a channel and clears its spent budget", async () => {
    const hub = channel("lifecycle-restart");
    const outcome = await runInDurableObject(hub, async (instance, state) => {
      const sql = state.storage.sql;
      const api = instance as unknown as Lifecycle;
      seedBoundChannel(sql, "m-restart", "user-restart@im.wechat");
      sql.exec(
        `UPDATE member_connections SET poll_status = 'needs_reset' WHERE member_id = 'm-restart'`,
      );
      await state.storage.put("flush:defer:conn-m-restart:1", 6);
      await state.storage.put("channel:error:conn-m-restart", "SEND_EXHAUSTED");
      await api.restartChannel(ownerPrincipal(), "m-restart");
      return {
        status: sql
          .exec<{ poll_status: string }>(
            `SELECT poll_status FROM member_connections WHERE member_id = 'm-restart'`,
          )
          .toArray()[0]?.poll_status,
        budget: await state.storage.get("flush:defer:conn-m-restart:1"),
        error: await state.storage.get("channel:error:conn-m-restart"),
      };
    });
    expect(outcome.status).toBe("polling");
    expect(outcome.budget).toBeUndefined();
    expect(outcome.error).toBeUndefined();
  });

  it("refuses to restart an expired channel", async () => {
    const hub = channel("lifecycle-expired");
    const error = await runInDurableObject(hub, async (instance, state) => {
      seedBoundChannel(state.storage.sql, "m-exp", "user-exp@im.wechat");
      state.storage.sql.exec(
        `UPDATE member_connections SET poll_status = 'expired' WHERE member_id = 'm-exp'`,
      );
      const api = instance as unknown as Lifecycle;
      return await api
        .restartChannel(ownerPrincipal(), "m-exp")
        .catch((caught: unknown) => caught);
    });
    expect(error).toBeInstanceOf(MemberError);
    expect((error as MemberError).code).toBe("REBIND_REQUIRED");
  });
});
