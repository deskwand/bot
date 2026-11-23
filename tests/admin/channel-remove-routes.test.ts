import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createChannelAdminRoutes } from "../../src/admin/channel-routes";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

async function seeded(channelId: string, withLoginTables: boolean) {
  const stub = env.CHANNELS.get(
    env.CHANNELS.idFromName(`remove-${crypto.randomUUID()}`),
  );
  await runInDurableObject(stub, (instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `INSERT INTO members (id, label, role, status, epoch) VALUES (?, '小宝', 'member', 'active', 1)`,
      channelId,
    );
    sql.exec(
      `INSERT INTO member_connections
         (id, member_id, account_id, user_id, credential_key, credentials_hash,
          generation, status, cursor, conversation_id, poll_status)
       VALUES (?, ?, 'acct', 'user', 'cred', 'hash', 1, 'active', 'cur', 'user', 'polling')`,
      `conn-${channelId}`,
      channelId,
    );
    sql.exec(
      `INSERT INTO member_invites
         (id, label, kind, token_hash, member_id, target_member_id, status, created_at, expires_at)
       VALUES (?, '小宝', 'new', 'h', ?, NULL, 'consumed', 0, 0)`,
      `inv-${channelId}`,
      channelId,
    );
    if (withLoginTables) {
      // Only these two are created lazily; a scan-bound channel has neither.
      const { LoginStateStore } = instance as unknown as { LoginStateStore?: never };
      void LoginStateStore;
      instance.constructor.name;
    }
  });
  return { stub, routes: createChannelAdminRoutes({ channel: () => stub as never }) };
}

function del(routes: ReturnType<typeof createChannelAdminRoutes>, id: string) {
  return routes.fetch(new Request(`https://bot.example/admin/channels/${id}`, { method: "DELETE" }));
}

describe("removing a channel through the route", () => {
  it("works on a channel that was never assigned a PIN", async () => {
    const { routes } = await seeded("m-scan", false);
    const res = await del(routes, "m-scan");
    // The login tables are created on first use; deleting from them must not
    // turn a removal into a 503.
    expect(res.status).toBe(204);
  });

  it("finishes a removal that a previous attempt left half-done", async () => {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(`remove-half-${crypto.randomUUID()}`));
    await runInDurableObject(stub, (_instance, state) => {
      // The connection is already gone: an earlier attempt deleted it before it
      // failed. The channel row is what remains, and it must still be removable.
      state.storage.sql.exec(
        `INSERT INTO members (id, label, role, status, epoch) VALUES ('m-half','小宝','member','active',1)`,
      );
    });
    const routes = createChannelAdminRoutes({ channel: () => stub as never });
    const res = await del(routes, "m-half");
    expect(res.status).toBe(204);
  });

  it("refuses to remove the first channel", async () => {
    const { routes } = await seeded("m-scan2", false);
    const res = await del(routes, "owner");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "CHANNEL_IMMUTABLE" });
  });
});
