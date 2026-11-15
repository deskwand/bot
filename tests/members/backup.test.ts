import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BackupRpc, KV_TABLE } from "../../src/admin/backup-rpc";
import { PRIVATE_WECHAT_PREFIX } from "../../src/members/credentials";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function hub(name: string) {
  return env.CHANNELS.get(env.CHANNELS.idFromName(name));
}

describe("backup excludes WeChat credentials", () => {
  it("跳过私有凭据但继续扫过它们，普通键仍被导出", async () => {
    const stub = hub(`backup-${crypto.randomUUID()}`);
    const page = await runInDurableObject(stub, async (instance, state) => {
      // Fill a page with only secrets, then a real key: the cursor must still
      // advance past them instead of ending the dump.
      for (let i = 0; i < 130; i += 1) {
        await state.storage.put(
          `${PRIVATE_WECHAT_PREFIX}credential-${String(i).padStart(3, "0")}`,
          `secret-${i}`,
        );
      }
      await state.storage.put("meta:ordinary", { hello: "world" });
      const backup = new BackupRpc(state, null);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const result = await backup.backupPage(KV_TABLE, cursor);
        for (const row of result.rows) seen.push(String(row.key));
        cursor = result.next;
        if (cursor === null) break;
        void instance;
      }
      return seen;
    });
    expect(page).toContain("meta:ordinary");
    expect(page.some((key) => key.startsWith(PRIVATE_WECHAT_PREFIX))).toBe(false);
    expect(JSON.stringify(page)).not.toContain("secret-129");
  });

  it("成员管家的备份请求到达成员对象，而不是主人", async () => {
    const { createAdminGateway } = await import("../../src/admin/admin-gateway");
    const ownerHits: string[] = [];
    const memberHits: string[] = [];
    const fake = (hits: string[], tag: string) =>
      new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (prop === "backupSchema") return async () => {
              hits.push(`${tag}:schema`);
              return { tables: [], indexes: [] };
            };
            if (prop === "renewMaintenance") return async () => true;
            return () => {
              hits.push(`${tag}:${String(prop)}`);
              return Promise.resolve(null);
            };
          },
        },
      );
    const gateway = createAdminGateway({
      token: "admin-token",
      versionId: "version-1",
      butler: (id?: string) =>
        (id === undefined
          ? fake(ownerHits, "owner")
          : fake(memberHits, `member:${id}`)) as never,
      channel: () => fake([], "channel") as never,
      task: () => fake([], "task") as never,
      bot: () => fake([], "bot") as never,
      life: () => fake([], "life") as never,
      wallet: () => fake([], "wallet") as never,
      artifacts: {} as never,
      mcpAuth: () => fake([], "mcp") as never,
      locale: () => "zh",
      probeExchange: async () => null,
      ingestExchangeSnapshot: async () => {},
      walletReads: {},
    } as never);
    const member = "m" + "a".repeat(32);
    const res = await gateway.fetch(
      new Request(
        `https://bot.example/admin/backup/schema?do=butler&id=${member}`,
        {
          headers: {
            authorization: "Bearer admin-token",
            "X-Backup-Op": "op-1",
          },
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(memberHits).toEqual([`member:${member}:schema`]);
    expect(ownerHits).toEqual([]);
  });

  it("恢复后成员连接不再持有可用凭据，邀请与队列作废", async () => {
    const stub = hub(`restore-${crypto.randomUUID()}`);
    const outcome = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put(`${PRIVATE_WECHAT_PREFIX}credential-x`, "token-x");
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO outbound_queue
           (conversation_id, text, buttons_json, priority, attempts, created_at, connection_id, generation)
         VALUES ('user-x', 'queued', NULL, 0, 0, 1, 'c-x', 1)`,
      );
      await (instance as unknown as {
        resetMemberAccessAfterRestore(): Promise<void>;
      }).resetMemberAccessAfterRestore();
      const left = await state.storage.list({ prefix: PRIVATE_WECHAT_PREFIX });
      const queue = state.storage.sql
        .exec(`SELECT id FROM outbound_queue WHERE connection_id <> 'owner'`)
        .toArray();
      return { keys: [...left.keys()], queue };
    });
    expect(outcome.keys).toEqual([]);
    expect(outcome.queue).toEqual([]);
  });
});
