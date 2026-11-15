import { describe, expect, it } from "vitest";
import {
  AttachmentAccess,
  LEGACY_SCHEMA_V1,
  bootstrapMemberSchema,
  migrateLegacyInbox,
  migrationReady,
  recordArchiveVersion,
} from "../../src/members/artifact-access";
import {
  ARTIFACT_KEY_MISMATCH,
  MemberAccessClient,
} from "../../src/members/client";
import { ownerPrincipal } from "../../src/members/principal";
import { MemberStore } from "../../src/members/store";
import { memberBinding, ownerBinding, seedLegacySchema, withMemberState } from "../helpers/members";

describe("AttachmentAccess", () => {
  it("重复相同登记幂等，不同主体登记拒绝", async () => {
    await withMemberState((state) => {
      const access = new AttachmentAccess(state.storage.sql);
      access.record("owner", "inbox/e1/a.txt");
      access.record("owner", "inbox/e1/a.txt");
      expect(access.owns("owner", "inbox/e1/a.txt")).toBe(true);
      expect(access.owns("member-1", "inbox/e1/a.txt")).toBe(false);
      expect(() => access.record("member-1", "inbox/e1/a.txt")).toThrow(
        "ATTACHMENT_OWNED_BY_OTHER",
      );
      expect(access.owns("owner", "inbox/e1/a.txt")).toBe(true);
    });
  });

  it("未知 key 不靠 owner→true 放行", async () => {
    await withMemberState((state) => {
      const access = new AttachmentAccess(state.storage.sql);
      expect(access.owns("owner", "inbox/unknown/x.txt")).toBe(false);
      access.record("member-1", "inbox/e2/m.txt");
      expect(access.owns("owner", "inbox/e2/m.txt")).toBe(false);
    });
  });
});

describe("legacy inbox backfill", () => {
  it("升级前旧 owner inbox 分页归主人且只跑一次", async () => {
    await withMemberState(async (state) => {
      const sql = state.storage.sql;
      seedLegacySchema(sql);
      const access = new AttachmentAccess(sql);
      const seen: (string | undefined)[] = [];
      const list = async (cursor?: string) => {
        seen.push(cursor);
        if (cursor === undefined) {
          return {
            keys: ["inbox/e1/a.txt", "inbox/e1/b.txt"],
            cursor: "page-2",
          };
        }
        return { keys: ["inbox/e2/c.txt"], cursor: undefined };
      };

      const first = await migrateLegacyInbox({ sql, access, list });
      expect(first).toEqual({ claimed: 3, skipped: false, done: true });
      expect(seen).toEqual([undefined, "page-2"]);
      expect(access.owns("owner", "inbox/e1/a.txt")).toBe(true);
      expect(access.owns("owner", "inbox/e2/c.txt")).toBe(true);
      expect(migrationReady(sql)).toBe(true);

      let listed = 0;
      const second = await migrateLegacyInbox({
        sql,
        access,
        list: async () => {
          listed += 1;
          return { keys: ["inbox/e3/d.txt"] };
        },
      });
      expect(second).toEqual({ claimed: 0, skipped: false, done: true });
      expect(listed).toBe(0);
      expect(access.owns("owner", "inbox/e3/d.txt")).toBe(false);
    });
  });

  it("全新成员库没有可迁移的旧 inbox", async () => {
    await withMemberState(async (state) => {
      const sql = state.storage.sql;
      const store = new MemberStore(sql);
      store.ensureOwner();
      const access = new AttachmentAccess(sql);
      let listed = 0;
      const result = await migrateLegacyInbox({
        sql,
        access,
        list: async () => {
          listed += 1;
          return { keys: ["inbox/e1/a.txt"] };
        },
      });
      expect(result).toEqual({
        claimed: 0,
        skipped: true,
        done: true,
        reason: "schema",
      });
      expect(listed).toBe(0);
      expect(access.owns("owner", "inbox/e1/a.txt")).toBe(false);
      expect(migrationReady(sql)).toBe(true);
    });
  });

  it("已有成员（升级后/缺 ACL）时拒绝全量归主人并报告", async () => {
    await withMemberState(async (state) => {
      const sql = state.storage.sql;
      seedLegacySchema(sql);
      const access = new AttachmentAccess(sql);
      // A member row that existed before this boot's backfill ran.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS members (
          id TEXT PRIMARY KEY, label TEXT NOT NULL, role TEXT NOT NULL,
          status TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 1
        )`,
      );
      sql.exec(
        `INSERT INTO members (id, label, role, status, epoch)
         VALUES ('m2', 'x', 'member', 'active', 1)`,
      );

      let listed = 0;
      const result = await migrateLegacyInbox({
        sql,
        access,
        list: async () => {
          listed += 1;
          return { keys: ["inbox/e1/a.txt"] };
        },
      });
      expect(result).toEqual({
        claimed: 0,
        skipped: true,
        done: true,
        reason: "members",
      });
      expect(listed).toBe(0);
      expect(access.owns("owner", "inbox/e1/a.txt")).toBe(false);
    });
  });

  it("成员库缺迁移标记与 ACL 时来源未知，拒绝全量归主人", async () => {
    await withMemberState(async (state) => {
      const sql = state.storage.sql;
      // The fixture DO's production constructor created the members-aware
      // tables; `wechat_state` exists too. Simulate a v2 database that lost
      // its provenance marker, its migration marker and every ACL row: no
      // surviving table proves it predates members.
      new MemberStore(sql).ensureOwner();
      expect(() => sql.exec(`SELECT 1 FROM wechat_state LIMIT 1`)).not.toThrow();
      sql.exec(`DELETE FROM member_migrations`);
      expect(
        bootstrapMemberSchema(sql, () => 1_700_000_000_000),
      ).not.toBe(LEGACY_SCHEMA_V1);

      const access = new AttachmentAccess(sql);
      let listed = 0;
      const result = await migrateLegacyInbox({
        sql,
        access,
        list: async () => {
          listed += 1;
          return { keys: ["inbox/e1/a.txt"] };
        },
      });
      expect(result).toEqual({
        claimed: 0,
        skipped: true,
        done: true,
        reason: "schema",
      });
      expect(listed).toBe(0);
      expect(access.owns("owner", "inbox/e1/a.txt")).toBe(false);
      // The refusal settles the question, so activation is not stuck forever.
      expect(migrationReady(sql)).toBe(true);
    });
  });

  it("v2 恢复只有 owner 且缺 ACL 时绝不全量归主人", async () => {
    await withMemberState(async (state) => {
      const sql = state.storage.sql;
      const store = new MemberStore(sql);
      store.importOwner(ownerBinding);
      recordArchiveVersion(sql, "v2");

      let listed = 0;
      const access = new AttachmentAccess(sql);
      const result = await migrateLegacyInbox({
        sql,
        access,
        list: async () => {
          listed += 1;
          return { keys: ["inbox/e1/a.txt"] };
        },
      });
      expect(result).toEqual({
        claimed: 0,
        skipped: true,
        done: true,
        reason: "schema",
      });
      expect(listed).toBe(0);
      expect(access.owns("owner", "inbox/e1/a.txt")).toBe(false);
      // The archive already resolved the question: activation stays possible.
      expect(migrationReady(sql)).toBe(true);
    });
  });

  it("v1 归档恢复仍可做一次性归主人", async () => {
    await withMemberState(async (state) => {
      const sql = state.storage.sql;
      seedLegacySchema(sql);
      recordArchiveVersion(sql, "v1");
      const access = new AttachmentAccess(sql);
      const result = await migrateLegacyInbox({
        sql,
        access,
        list: async () => ({ keys: ["inbox/e1/a.txt"] }),
      });
      expect(result).toEqual({ claimed: 1, skipped: false, done: true });
      expect(access.owns("owner", "inbox/e1/a.txt")).toBe(true);
    });
  });

  it("分页途中出现成员即中止，迁移保持未就绪", async () => {
    await withMemberState(async (state) => {
      const sql = state.storage.sql;
      seedLegacySchema(sql);
      const access = new AttachmentAccess(sql);
      let page = 0;
      const result = await migrateLegacyInbox({
        sql,
        access,
        list: async () => {
          page += 1;
          if (page === 2) {
            sql.exec(
              `INSERT OR REPLACE INTO members (id, label, role, status, epoch)
               VALUES ('m9', 'x', 'member', 'active', 1)`,
            );
            return { keys: ["inbox/e2/b.txt"] };
          }
          return { keys: ["inbox/e1/a.txt"], cursor: "page-2" };
        },
      });
      expect(result).toEqual({
        claimed: 1,
        skipped: true,
        done: false,
        reason: "conflict",
      });
      expect(access.owns("owner", "inbox/e2/b.txt")).toBe(false);
      expect(migrationReady(sql)).toBe(false);
    });
  });
});

describe("MemberAccessClient", () => {
  async function withClient(
    run: (ctx: {
      store: MemberStore;
      access: AttachmentAccess;
      client: MemberAccessClient;
      memberId: string;
      inviteLabel: string;
    }) => void | Promise<void>,
  ): Promise<void> {
    await withMemberState(async (state) => {
      const store = new MemberStore(state.storage.sql);
      const access = new AttachmentAccess(state.storage.sql);
      store.ensureOwner();
      const invite = store.createInvite("小王");
      const member = store.completeInvite(invite.inviteId, memberBinding);
      const tasks = new Map([
        ["t1", { taskId: "t1", memberId: "owner", keyPrefix: "t1/" }],
        [
          `${member.memberId}-t1`,
          { taskId: `${member.memberId}-t1`, memberId: member.memberId, keyPrefix: `${member.memberId}-t1/` },
        ],
      ]);
      const client = new MemberAccessClient(
        store,
        access,
        async (taskId) => tasks.get(taskId) ?? null,
      );
      await run({ store, access, client, memberId: member.memberId, inviteLabel: "小王" });
    });
  }

  it("成员只能读自己名下附件，主人不能代读", async () => {
    await withClient(({ access, client, memberId }) => {
      const memberActor = { memberId, role: "member" as const, epoch: 1 };
      access.record(memberId, "inbox/e9/m.txt");
      expect(client.resolveMemberAttachment(memberActor, "inbox/e9/m.txt")).toBe(
        "inbox/e9/m.txt",
      );
      expect(() =>
        client.resolveMemberAttachment(ownerPrincipal(), "inbox/e9/m.txt"),
      ).toThrow("MEMBER_ACCESS_DENIED");
      expect(() =>
        client.resolveMemberAttachment(memberActor, "inbox/e9/other.txt"),
      ).toThrow("MEMBER_ACCESS_DENIED");
    });
  });

  it("owner 通过 spawn_task 传成员 key 被拒", async () => {
    await withClient(async ({ access, client, memberId }) => {
      access.record(memberId, "inbox/e9/m.txt");
      await expect(
        client.registerTaskArtifact(ownerPrincipal(), "t1", "inbox/e9/m.txt"),
      ).rejects.toThrow(ARTIFACT_KEY_MISMATCH);
      await expect(
        client.registerTaskArtifact(ownerPrincipal(), "t1", "t1/../inbox/e9/m.txt"),
      ).rejects.toThrow(ARTIFACT_KEY_MISMATCH);
      expect(access.owns("owner", "inbox/e9/m.txt")).toBe(false);
    });
  });

  it("任务归属不匹配时拒绝登记（模型参数不能自选归属）", async () => {
    await withClient(async ({ client, memberId }) => {
      await expect(
        client.registerTaskArtifact(
          ownerPrincipal(),
          `${memberId}-t1`,
          `${memberId}-t1/report.txt`,
        ),
      ).rejects.toThrow("MEMBER_ACCESS_DENIED");

      const memberActor = { memberId, role: "member" as const, epoch: 1 };
      await expect(
        client.registerTaskArtifact(memberActor, "t1", "t1/report.txt"),
      ).rejects.toThrow("MEMBER_ACCESS_DENIED");
      await expect(
        client.registerTaskArtifact(memberActor, "t404", `${memberId}-t1/x.txt`),
      ).rejects.toThrow("TASK_NOT_FOUND");

      await client.registerTaskArtifact(
        memberActor,
        `${memberId}-t1`,
        `${memberId}-t1/report.txt`,
      );
      expect(client.resolveMemberAttachment(memberActor, `${memberId}-t1/report.txt`)).toBe(
        `${memberId}-t1/report.txt`,
      );
    });
  });
});
