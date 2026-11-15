import { describe, expect, it } from "vitest";
import {
  CredentialStaging,
  CredentialVault,
  PRIVATE_WECHAT_PREFIX,
  stageCredentialAndActivate,
} from "../../src/members/credentials";
import { MemberStore } from "../../src/members/store";
import { ownerBinding, withMemberState } from "../helpers/members";

const OWNER = { ...ownerBinding, credentialHash: "fake-owner-hash" };

describe("CredentialVault", () => {
  it("所有 key 都落在 private:wechat: 前缀下", async () => {
    await withMemberState(async (state) => {
      const vault = new CredentialVault(state.storage);
      await vault.put("credential-a-op1", { token: "fake-token-a" });

      const listed = await state.storage.list({
        prefix: PRIVATE_WECHAT_PREFIX,
      });
      expect([...listed.keys()]).toEqual([
        `${PRIVATE_WECHAT_PREFIX}credential-a-op1`,
      ]);
      expect(await state.storage.get("credential-a-op1")).toBeUndefined();
      expect(await vault.get<{ token: string }>("credential-a-op1")).toEqual({
        token: "fake-token-a",
      });

      await vault.delete("credential-a-op1");
      expect(await vault.get("credential-a-op1")).toBeUndefined();
      expect(PRIVATE_WECHAT_PREFIX).toBe("private:wechat:");
    });
  });

  it("不同连接的凭据互不覆盖", async () => {
    await withMemberState(async (state) => {
      const vault = new CredentialVault(state.storage);
      await vault.put("credential-a-op1", { token: "fake-token-a" });
      await vault.put("credential-a-op2", { token: "fake-token-a2" });
      expect(await vault.get("credential-a-op1")).toEqual({
        token: "fake-token-a",
      });
      expect(await vault.get("credential-a-op2")).toEqual({
        token: "fake-token-a2",
      });
    });
  });
});

describe("CredentialStaging", () => {
  it("每次操作分配不同候选 key，调用方 key 不会被覆盖", async () => {
    await withMemberState(async (state) => {
      const vault = new CredentialVault(state.storage);
      const staging = new CredentialStaging(state.storage.sql, vault);
      const one = await staging.stage("wechat-a", { token: "fake-1" });
      const two = await staging.stage("wechat-a", { token: "fake-2" });
      expect(one).not.toBe(two);
      expect(one.startsWith("wechat-a")).toBe(true);
      expect(await vault.get(one)).toEqual({ token: "fake-1" });
      expect(await vault.get(two)).toEqual({ token: "fake-2" });
      // The base key itself is never written.
      expect(await vault.get("wechat-a")).toBeUndefined();
      expect(
        state.storage.sql
          .exec(`SELECT key FROM credential_staging ORDER BY key`)
          .toArray()
          .map((row) => (row as { key: string }).key),
      ).toEqual([one, two].sort());
    });
  });

  it("vault 保存失败时不留下候选与暂存记录", async () => {
    let activated = false;
    const vault = {
      put: async () => {
        throw new Error("VAULT_UNAVAILABLE");
      },
      delete: async () => {},
    };
    await withMemberState(async (state) => {
      const staging = new CredentialStaging(
        state.storage.sql,
        vault as unknown as CredentialVault,
      );
      await expect(
        stageCredentialAndActivate(staging, "wechat-a", {}, () => {
          activated = true;
        }),
      ).rejects.toThrow("VAULT_UNAVAILABLE");
      expect(activated).toBe(false);
      expect(
        state.storage.sql.exec(`SELECT key FROM credential_staging`).toArray(),
      ).toEqual([]);
    });
  });

  it("SQL 激活失败只删除本次候选，不碰胜出 key", async () => {
    await withMemberState(async (state) => {
      const vault = new CredentialVault(state.storage);
      const staging = new CredentialStaging(state.storage.sql, vault);
      const winner = await staging.stage("wechat-a", {
        token: "fake-token-winner",
      });
      // The winner is live: the directory points at it.
      const store = new MemberStore(state.storage.sql);
      store.importOwner({ ...OWNER, credentialKey: winner });
      staging.commit(winner);

      await expect(
        stageCredentialAndActivate(
          staging,
          "wechat-a",
          { token: "fake-token-candidate" },
          () => {
            throw new Error("SQL_ACTIVATION_FAILED");
          },
        ),
      ).rejects.toThrow("SQL_ACTIVATION_FAILED");

      expect(await vault.get(winner)).toEqual({
        token: "fake-token-winner",
      });
      expect(
        state.storage.sql
          .exec(`SELECT key FROM credential_staging`)
          .toArray(),
      ).toEqual([]);
    });
  });

  it("激活成功后候选成为指针并清除暂存记录", async () => {
    await withMemberState(async (state) => {
      const vault = new CredentialVault(state.storage);
      const staging = new CredentialStaging(state.storage.sql, vault);
      const store = new MemberStore(state.storage.sql);
      const candidate = await stageCredentialAndActivate(
        staging,
        "wechat-a",
        { token: "fake-token-candidate" },
        (key) => {
          store.importOwner({ ...OWNER, credentialKey: key });
          return key;
        },
      );
      expect(store.credentialKeyOf("owner")).toBe(candidate);
      expect(await vault.get(candidate)).toEqual({
        token: "fake-token-candidate",
      });
      expect(
        state.storage.sql
          .exec(`SELECT key FROM credential_staging`)
          .toArray(),
      ).toEqual([]);
    });
  });

  it("删除候选失败时保留暂存记录，重启后清理重试", async () => {
    await withMemberState(async (state) => {
      const real = new CredentialVault(state.storage);
      const failing = {
        put: (key: string, value: unknown) => real.put(key, value),
        get: <T,>(key: string) => real.get<T>(key),
        delete: async () => {
          throw new Error("VAULT_DELETE_FAILED");
        },
      };
      const staging = new CredentialStaging(
        state.storage.sql,
        failing as unknown as CredentialVault,
      );

      let candidate = "";
      await expect(
        stageCredentialAndActivate(
          staging,
          "wechat-a",
          { token: "fake-token-candidate" },
          (key) => {
            candidate = key;
            throw new Error("SQL_ACTIVATION_FAILED");
          },
        ),
      ).rejects.toThrow("SQL_ACTIVATION_FAILED");

      // Cleanup failed: the candidate and its staging row both survive, so the
      // next boot can still find the orphan.
      expect(await real.get(candidate)).toEqual({
        token: "fake-token-candidate",
      });
      expect(
        state.storage.sql
          .exec(`SELECT key FROM credential_staging`)
          .toArray(),
      ).toEqual([{ key: candidate }]);

      // "Restart": a fresh instance over the same storage retries the delete.
      const restarted = new CredentialStaging(state.storage.sql, real);
      expect(await restarted.reconcile()).toEqual([candidate]);
      expect(await real.get(candidate)).toBeUndefined();
      expect(
        state.storage.sql
          .exec(`SELECT key FROM credential_staging`)
          .toArray(),
      ).toEqual([]);
    });
  });

  it("重启清理只删未被指针引用的候选", async () => {
    await withMemberState(async (state) => {
      const vault = new CredentialVault(state.storage);
      const first = new CredentialStaging(state.storage.sql, vault);

      // A crashed operation: staged but never activated.
      const orphan = await first.stage("wechat-a", { token: "fake-orphan" });
      // A completed operation: the directory points at it.
      const store = new MemberStore(state.storage.sql);
      const live = await first.stage("wechat-owner", { token: "fake-live" });
      store.importOwner({ ...OWNER, credentialKey: live });
      first.commit(live);

      // "Restart": fresh instances over the same storage.
      const restartVault = new CredentialVault(state.storage);
      const restarted = new CredentialStaging(
        state.storage.sql,
        restartVault,
      );
      expect(await restarted.reconcile()).toEqual([orphan]);
      expect(await restartVault.get(orphan)).toBeUndefined();
      expect(await restartVault.get(live)).toEqual({ token: "fake-live" });
      expect(store.credentialKeyOf("owner")).toBe(live);
    });
  });
});
