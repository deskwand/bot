import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ChannelDO } from "../../src/channels/channel-do";
import { migrateLegacyInbox, migrationReady } from "../../src/members/artifact-access";
import type { VerifiedBinding } from "../../src/members/store";
import {
  MEMBER_NOW,
  memberBinding,
  ownerBinding,
  seedLegacySchema,
  withFaultingMemberStore,
  withMemberStore,
  withMemberStoreSql,
} from "../helpers/members";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function bindingOverrides(
  binding: VerifiedBinding,
  patch: Partial<VerifiedBinding>,
): VerifiedBinding {
  return { ...binding, ...patch };
}

describe("MemberStore", () => {
  it("新成员不替换主人且重复绑定幂等", async () => {
    await withMemberStore((store) => {
      store.importOwner(ownerBinding);
      const invite = store.createInvite("小王");
      const one = store.completeInvite(invite.inviteId, memberBinding);
      const two = store.completeInvite(invite.inviteId, memberBinding);
      expect(two.memberId).toBe(one.memberId);
      expect(store.list()).toHaveLength(2);
      expect(store.principal("owner")?.role).toBe("owner");
    });
  });

  it("撤销使旧 epoch 的活动检查失败", async () => {
    await withMemberStore((store) => {
      const invite = store.createInvite("小王");
      const member = store.completeInvite(invite.inviteId, memberBinding);
      const a = store.principal(member.memberId)!;
      store.revoke(a.memberId);
      expect(() => store.assertActive(a)).toThrow("MEMBER_ACCESS_DENIED");
    });
  });

  it("未知主体与伪造主人角色都 fail closed", async () => {
    await withMemberStore((store) => {
      store.ensureOwner();
      expect(() =>
        store.assertActive({ memberId: "mdeadbeef", role: "member", epoch: 1 }),
      ).toThrow("MEMBER_ACCESS_DENIED");

      const invite = store.createInvite("小王");
      const member = store.completeInvite(invite.inviteId, memberBinding);
      expect(() =>
        store.assertActive({
          memberId: member.memberId,
          role: "owner",
          epoch: member.epoch,
        }),
      ).toThrow("MEMBER_ACCESS_DENIED");

      store.assertActive(store.principal("owner")!);
    });
  });

  it("邀请过期一毫秒即失效", async () => {
    let clock = MEMBER_NOW;
    await withMemberStore(
      (store) => {
        const invite = store.createInvite("小王", { ttlMs: 60_000 });
        clock = MEMBER_NOW + 60_000;
        expect(() =>
          store.completeInvite(invite.inviteId, memberBinding),
        ).toThrow("INVITE_EXPIRED");
        expect(store.list()).toHaveLength(1);
      },
      () => clock,
    );
  });

  it("默认邀请有效期为 15 分钟", async () => {
    let clock = MEMBER_NOW;
    const fifteenMinutes = 15 * 60 * 1000;
    await withMemberStore(
      (store) => {
        const invite = store.createInvite("小王");
        expect(invite.expiresAt).toBe(MEMBER_NOW + fifteenMinutes);
        clock = MEMBER_NOW + fifteenMinutes - 1;
        const member = store.completeInvite(invite.inviteId, memberBinding);
        expect(store.principal(member.memberId)?.role).toBe("member");
      },
      () => clock,
    );

    clock = MEMBER_NOW;
    await withMemberStore(
      (store) => {
        const invite = store.createInvite("小王");
        clock = MEMBER_NOW + fifteenMinutes;
        expect(() =>
          store.completeInvite(invite.inviteId, memberBinding),
        ).toThrow("INVITE_EXPIRED");
      },
      () => clock,
    );
  });

  it("取消后的邀请不能再确认", async () => {
    await withMemberStore((store) => {
      const invite = store.createInvite("小王");
      store.cancelInvite(invite.inviteId);
      expect(() =>
        store.completeInvite(invite.inviteId, memberBinding),
      ).toThrow("INVITE_CANCELLED");
    });
  });

  it("两个邀请绑定同一 userId 只成功一次", async () => {
    await withMemberStore((store) => {
      const first = store.createInvite("小王");
      const second = store.createInvite("小王二");
      const member = store.completeInvite(first.inviteId, memberBinding);
      expect(() =>
        store.completeInvite(
          second.inviteId,
          bindingOverrides(memberBinding, {
            connectionId: "c-a2",
            credentialKey: "credential-a-op2",
          }),
        ),
      ).toThrow("USER_ALREADY_BOUND");
      expect(store.list()).toHaveLength(2);
      expect(store.principal(member.memberId)?.role).toBe("member");
    });
  });

  it("成员创建失败时整个激活回滚：不留成员、邀请仍待确认", async () => {
    await withMemberStoreSql((store, sql) => {
      store.importOwner(ownerBinding);
      const invite = store.createInvite("小王");
      // Same primary key as the owner connection: the connection INSERT fails
      // *after* the member INSERT inside the transaction.
      expect(() =>
        store.completeInvite(
          invite.inviteId,
          bindingOverrides(memberBinding, {
            connectionId: ownerBinding.connectionId,
          }),
        ),
      ).toThrow();
      expect(store.list()).toHaveLength(1);
      expect(
        sql
          .exec(`SELECT status FROM member_invites WHERE id = ?`, invite.inviteId)
          .toArray(),
      ).toEqual([{ status: "pending" }]);
      expect(
        sql.exec(`SELECT member_id FROM member_connections`).toArray(),
      ).toEqual([{ member_id: "owner" }]);
      // Still consumable: nothing was half-written.
      const member = store.completeInvite(invite.inviteId, memberBinding);
      expect(store.principal(member.memberId)?.role).toBe("member");
    });
  });

  it("指针激活后同一事务内的失败也会回滚旧连接与邀请", async () => {
    let transactions = 0;
    await withFaultingMemberStore(
      (sql) => {
        transactions += 1;
        // Fail only the rebind transaction, with a real constraint error after
        // the pointer moved.
        if (transactions !== 2) return;
        sql.exec(
          `INSERT INTO members (id, label, role, status, epoch)
           VALUES ('owner', 'dup', 'member', 'active', 1)`,
        );
      },
      (store, sql) => {
        const invite = store.createInvite("小王");
        const member = store.completeInvite(invite.inviteId, memberBinding);
        const rebind = store.createInvite("换号", {
          kind: "rebind",
          targetMemberId: member.memberId,
        });
        expect(() =>
          store.completeInvite(
            rebind.inviteId,
            bindingOverrides(memberBinding, {
              connectionId: "c-a-op2",
              credentialKey: "credential-a-op2",
            }),
          ),
        ).toThrow();
        // The pointer is still the pre-rebind key and the invite is pending.
        expect(
          sql
            .exec(
              `SELECT credential_key FROM member_connections WHERE member_id = ?`,
              member.memberId,
            )
            .toArray(),
        ).toEqual([{ credential_key: memberBinding.credentialKey }]);
        expect(
          sql
            .exec(`SELECT status FROM member_invites WHERE id = ?`, rebind.inviteId)
            .toArray(),
        ).toEqual([{ status: "pending" }]);
      },
    );
  });

  it("重绑的期望身份来自已存连接，调用方不能自选", async () => {
    await withMemberStore((store) => {
      const invite = store.createInvite("小王");
      const member = store.completeInvite(invite.inviteId, memberBinding);

      // Confirming another identity while creating the invite is refused.
      expect(() =>
        store.createInvite("换号", {
          kind: "rebind",
          targetMemberId: member.memberId,
          expectedUserId: "user-other",
        }),
      ).toThrow("MEMBER_ACCESS_DENIED");

      // A genuine replacement attempt: different user, same target member.
      const rebind = store.createInvite("换号", {
        kind: "rebind",
        targetMemberId: member.memberId,
      });
      expect(() =>
        store.completeInvite(
          rebind.inviteId,
          bindingOverrides(memberBinding, {
            connectionId: "c-b",
            accountId: "wx-b",
            userId: "user-b",
            credentialKey: "credential-b-op1",
          }),
        ),
      ).toThrow("MEMBER_ACCESS_DENIED");
      expect(store.principal(member.memberId)?.role).toBe("member");
    });
  });

  it("同一邀请两份凭据竞争时只有第一份生效", async () => {
    await withMemberStoreSql((store, sql) => {
      const invite = store.createInvite("小王");
      const member = store.completeInvite(invite.inviteId, memberBinding);
      const candidate = bindingOverrides(memberBinding, {
        connectionId: "c-a-race",
        credentialKey: "credential-a-race",
      });
      expect(() =>
        store.completeInvite(invite.inviteId, candidate),
      ).toThrow("INVITE_CONSUMED");

      const keys = sql
        .exec(
          `SELECT credential_key FROM member_connections WHERE member_id = ?`,
          member.memberId,
        )
        .toArray();
      expect(keys).toEqual([{ credential_key: memberBinding.credentialKey }]);
      expect(store.list()).toHaveLength(2);
    });
  });

  it("重绑保留成员 id 并换掉 credential_key 指针", async () => {
    await withMemberStoreSql((store, sql) => {
      const invite = store.createInvite("小王");
      const member = store.completeInvite(invite.inviteId, memberBinding);
      const rebind = store.createInvite("小王新机", {
        kind: "rebind",
        targetMemberId: member.memberId,
      });
      const rebound = store.completeInvite(
        rebind.inviteId,
        bindingOverrides(memberBinding, {
          connectionId: "c-a-op2",
          credentialKey: "credential-a-op2",
        }),
      );
      expect(rebound.memberId).toBe(member.memberId);
      const live = sql
        .exec(
          `SELECT credential_key, status FROM member_connections WHERE member_id = ? AND status <> 'retired'`,
          member.memberId,
        )
        .toArray();
      expect(live).toEqual([
        { credential_key: "credential-a-op2", status: "active" },
      ]);
    });
  });

  it("主人导入幂等：无新凭据不推进 generation，冲突 userId 不转移成员", async () => {
    await withMemberStoreSql((store, sql) => {
      store.ensureOwner();
      store.ensureOwner();
      store.importOwner(ownerBinding);
      store.importOwner(ownerBinding);
      expect(store.list()).toHaveLength(1);

      const generationOf = () =>
        sql
          .exec(
            `SELECT generation, credential_key FROM member_connections WHERE member_id = 'owner'`,
          )
          .toArray();
      expect(generationOf()).toEqual([
        { generation: 1, credential_key: ownerBinding.credentialKey },
      ]);

      store.importOwner(
        bindingOverrides(ownerBinding, {
          connectionId: "c-owner-op2",
          credentialKey: "credential-owner-op2",
        }),
      );
      expect(generationOf()).toEqual([
        { generation: 2, credential_key: "credential-owner-op2" },
      ]);
      expect(store.credentialHashOf("owner")).toBe(ownerBinding.credentialHash);

      // A member already owns user-a: the owner import must not steal it.
      const invite = store.createInvite("小王");
      store.completeInvite(invite.inviteId, memberBinding);
      expect(() =>
        store.importOwner(
          bindingOverrides(ownerBinding, {
            connectionId: "c-owner-conflict",
            credentialKey: "credential-owner-conflict",
            accountId: memberBinding.accountId,
            userId: memberBinding.userId,
          }),
        ),
      ).toThrow("MEMBER_ACCESS_DENIED");

      const memberRow = sql
        .exec(
          `SELECT user_id, credential_key FROM member_connections WHERE user_id = ?`,
          memberBinding.userId,
        )
        .toArray();
      expect(memberRow).toEqual([
        { user_id: "user-a", credential_key: memberBinding.credentialKey },
      ]);
    });
  });

  it("SQL 只留 key 指针与散列，不含 token", async () => {
    await withMemberStoreSql((store, sql) => {
      store.ensureOwner();
      store.importOwner(ownerBinding);
      const invite = store.createInvite("小王", {
        tokenHash: "fake-invite-token-hash",
      });
      const smuggled = {
        ...memberBinding,
        token: "fake-token-a",
      } as unknown as VerifiedBinding;
      store.completeInvite(invite.inviteId, smuggled);

      const dump = ["members", "member_connections", "member_invites"]
        .map((table) =>
          JSON.stringify(sql.exec(`SELECT * FROM ${table}`).toArray()),
        )
        .join("");
      expect(dump).not.toContain("fake-token-a");
      expect(dump).toContain(memberBinding.credentialKey);
      expect(dump).toContain(memberBinding.credentialHash);
    });
  });
});

describe("legacy inbox decision gates activation", () => {
  it("旧库迁移完成前激活失败，完成之后才允许", async () => {
    await withMemberStoreSql(async (store, sql) => {
      seedLegacySchema(sql);
      const access = { record() {}, owns: () => false };
      expect(migrationReady(sql)).toBe(false);
      const invite = store.createInvite("小王");
      expect(() =>
        store.completeInvite(invite.inviteId, memberBinding),
      ).toThrow("MEMBER_MIGRATION_PENDING");

      await migrateLegacyInbox({
        sql,
        access: access as never,
        list: async () => ({ keys: ["inbox/e1/a.txt"] }),
      });
      expect(migrationReady(sql)).toBe(true);
      const member = store.completeInvite(invite.inviteId, memberBinding);
      expect(member.role).toBe("member");
    });
  });

  it("迁移自身失败时保持未就绪，激活继续拒绝", async () => {
    await withMemberStoreSql(async (store, sql) => {
      seedLegacySchema(sql);
      const invite = store.createInvite("小王");
      await expect(
        migrateLegacyInbox({
          sql,
          access: {
            record() {
              throw new Error("R2_DOWN");
            },
            owns: () => false,
          } as never,
          list: async () => ({ keys: ["inbox/e1/a.txt"] }),
        }),
      ).resolves.toEqual({
        claimed: 0,
        skipped: true,
        done: false,
        reason: "conflict",
      });
      expect(migrationReady(sql)).toBe(false);
      expect(() =>
        store.completeInvite(invite.inviteId, memberBinding),
      ).toThrow("MEMBER_MIGRATION_PENDING");
    });
  });

  it("Telegram-only 空存储首次启动与重复启动都只有主人行", async () => {
    const stub = env.CHANNELS.get(
      env.CHANNELS.idFromName(`member-bootstrap-${crypto.randomUUID()}`),
    );
    const rows = await runInDurableObject(stub, (_instance, state) => {
      const testEnv = {
        ...(env as unknown as Env),
        ACTIVE_CHANNEL: "telegram",
        CF_VERSION_METADATA: { id: "member-bootstrap" },
      } as Env;
      new ChannelDO(state, testEnv);
      new ChannelDO(state, testEnv);
      return state.storage.sql
        .exec(`SELECT id, role, status FROM members`)
        .toArray();
    });
    expect(rows).toEqual([{ id: "owner", role: "owner", status: "active" }]);
  });
});
