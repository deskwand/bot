import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OwnerStore } from "../../src/channels/owner-store";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const NOW = 1_700_000_000_000;

function withStore<T>(
  run: (store: OwnerStore, sql: SqlStorage) => T,
): Promise<T> {
  const stub = env.CHANNELS.get(
    env.CHANNELS.idFromName("owner-store-test"),
  );
  return runInDurableObject(stub, (_instance, state) => {
    // 先构造 store：建表在构造函数里，清表必须在建表之后。
    const store = new OwnerStore(state.storage.sql, () => NOW);
    state.storage.sql.exec("DELETE FROM channel_claims");
    state.storage.sql.exec("DELETE FROM owner_addresses");
    return run(store, state.storage.sql);
  });
}

describe("OwnerStore", () => {
  it("读是纯的：没有行时不写库（状态接口不该启动窗口）", async () => {
    await withStore((store, sql) => {
      expect(store.read()).toEqual({
        ownerUserId: null,
        claimedAt: null,
        windowOpenedAt: 0,
      });
      expect(sql.exec(`SELECT channel FROM channel_claims`).toArray()).toEqual(
        [],
      );
    });
  });

  it("开窗会写入起点，并清掉当前主人（交棒语义）", async () => {
    await withStore((store) => {
      store.openWindow();
      expect(store.read()).toEqual({
        ownerUserId: null,
        claimedAt: null,
        windowOpenedAt: NOW,
      });
      store.claim("111");
      store.openWindow();
      expect(store.read()).toEqual({
        ownerUserId: null,
        claimedAt: null,
        windowOpenedAt: NOW,
      });
    });
  });

  it("认领写入主人并清掉旧地址", async () => {
    await withStore((store, sql) => {
      sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at) VALUES ('telegram', '42', 1)`,
      );
      store.openWindow();
      store.claim("111");
      expect(store.read()).toEqual({
        ownerUserId: "111",
        claimedAt: NOW,
        windowOpenedAt: NOW,
      });
      expect(sql.exec(`SELECT conversation_id FROM owner_addresses`).toArray()).toEqual([]);
    });
  });

  it("撤销清空主人并关闭窗口（起点 0）", async () => {
    await withStore((store) => {
      store.openWindow();
      store.claim("111");
      store.revoke();
      expect(store.read()).toEqual({
        ownerUserId: null,
        claimedAt: null,
        windowOpenedAt: 0,
      });
    });
  });

  it("撤销后再开窗会重新开始计时", async () => {
    await withStore((store) => {
      store.openWindow();
      store.claim("111");
      store.revoke();
      store.openWindow();
      expect(store.read()).toEqual({
        ownerUserId: null,
        claimedAt: null,
        windowOpenedAt: NOW,
      });
    });
  });
});
