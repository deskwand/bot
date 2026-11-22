import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/channels/route-identity";
import { setChannelOverride } from "../../src/channels/override";
import { t } from "../../src/i18n";
import { CredentialVault, inviteTokenKey } from "../../src/members/credentials";
import { ConnectionStore } from "../../src/channels/wechat/connections";
import { OutboundQueue } from "../../src/channels/outbound-queue";
import {
  butlerName,
  ownerPrincipal,
  OWNER_ID,
  type Principal,
} from "../../src/members/principal";
import {
  MEMBER_ACCESS_DENIED,
  MemberStore,
  type MemberInviteLink,
  type MemberView,
} from "../../src/members/store";
import {
  createMemberTools,
  type MemberAdminRpc,
} from "../../src/members/tools";
import { memberBinding } from "../helpers/members";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** The owner-only management surface this task adds to ChannelDO. */
type MemberAdmin = {
  listMembers(actor: Principal): Promise<MemberView[]>;
  createMemberInvite(actor: Principal, label: string): Promise<MemberInviteLink>;
  rebindMember(actor: Principal, memberId: string): Promise<MemberInviteLink>;
  cancelMemberInvite(actor: Principal, inviteId: string): Promise<void>;
  revokeMember(actor: Principal, memberId: string): Promise<void>;
};

const OWNER = ownerPrincipal();

const MANAGEMENT_TOOLS = [
  "invite_member",
  "rebind_member",
  "cancel_member_invite",
  "list_members",
  "revoke_member",
] as const;

function channelStub(name: string) {
  return env.CHANNELS.get(
    env.CHANNELS.idFromName(`${name}-${crypto.randomUUID()}`),
  );
}

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

/** A fixture DO boots with pre-members tables: settle the inbox decision. */
function settleLegacyInbox(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO member_migrations (name, cursor, done, updated_at)
     VALUES ('legacy-inbox-owner', NULL, 1, 1)
     ON CONFLICT(name) DO UPDATE SET done = 1`,
  );
}

type Seeded = {
  memberId: string;
  actor: Principal;
  credentialKey: string;
};

/** One real member, created through the real directory on real DO storage. */
function seedMember(
  store: MemberStore,
  sql: SqlStorage,
  label: string,
  suffix: string,
): Seeded {
  settleLegacyInbox(sql);
  const invite = store.createInvite(label);
  const member = store.completeInvite(invite.inviteId, {
    ...memberBinding,
    connectionId: `c-${suffix}`,
    credentialKey: `credential-${suffix}`,
    accountId: `wx-${suffix}`,
    userId: `user-${suffix}`,
  });
  const actor = store.principal(member.memberId);
  if (actor === null) throw new Error("member principal missing");
  return { memberId: member.memberId, actor, credentialKey: `credential-${suffix}` };
}

type Fixture = {
  runtime: MemberAdmin;
  store: MemberStore;
  sql: SqlStorage;
  vault: CredentialVault;
  seed(label: string, suffix: string): Seeded;
};

function withChannels<T>(
  name: string,
  run: (fixture: Fixture) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(channelStub(name), async (instance, state) => {
    const sql = state.storage.sql;
    const store = new MemberStore(sql, undefined, (fn) =>
      state.storage.transactionSync(fn),
    );
    const vault = (instance as unknown as { vault: CredentialVault }).vault;
    return await run({
      runtime: instance as unknown as MemberAdmin,
      store,
      sql,
      vault,
      seed: (label, suffix) => seedMember(store, sql, label, suffix),
    });
  });
}

function toolText(outcome: { output?: unknown; isError?: boolean }): string {
  const first = (outcome.output as { text: string }[] | undefined)?.[0];
  return first === undefined ? "" : first.text;
}

/** Runs one member-management tool exactly as the harness would. */
async function runTool(
  tools: ReturnType<typeof createMemberTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  const outcome = await tool.execute(args as never, {} as never, {} as never);
  return toolText(outcome);
}

/** A recording stand-in: a denied tool must never reach the runtime. */
function recording(runtime: MemberAdmin): { rpc: MemberAdmin; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rpc: {
      listMembers: (actor) => {
        calls.push("listMembers");
        return runtime.listMembers(actor);
      },
      createMemberInvite: (actor, label) => {
        calls.push("createMemberInvite");
        return runtime.createMemberInvite(actor, label);
      },
      rebindMember: (actor, memberId) => {
        calls.push("rebindMember");
        return runtime.rebindMember(actor, memberId);
      },
      cancelMemberInvite: (actor, inviteId) => {
        calls.push("cancelMemberInvite");
        return runtime.cancelMemberInvite(actor, inviteId);
      },
      revokeMember: (actor, memberId) => {
        calls.push("revokeMember");
        return runtime.revokeMember(actor, memberId);
      },
    },
  };
}

async function installedTools(stub: ReturnType<typeof butler>): Promise<string[]> {
  return runInDurableObject(stub, (instance) =>
    (
      instance as unknown as {
        registry: { snapshot(): { tools(): { tool: { name: string } }[] } };
      }
    )
      .registry.snapshot()
      .tools()
      .map(({ tool }) => tool.name),
  );
}

afterEach(() => {
  setChannelOverride("wechat", null);
  setChannelOverride("telegram", null);
});

describe("member management runtime", () => {
  it("主人邀请得到 fragment 链接，SQL 只存 sha256，vault 存明文", async () => {
    await withChannels("tools-invite", async (h) => {
      const link = await h.runtime.createMemberInvite(OWNER, "小王");

      expect(link.bindUrl).toContain("/members/bind/#");
      const token = link.bindUrl.split("#")[1] ?? "";
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(link.expiresAt).toBeGreaterThan(Date.now());

      const rows = h.sql
        .exec<{ tokenHash: string | null; status: string; kind: string }>(
          `SELECT token_hash AS tokenHash, status, kind FROM member_invites WHERE id = ?`,
          link.inviteId,
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("pending");
      expect(rows[0]!.kind).toBe("new");
      expect(rows[0]!.tokenHash).toBe(await sha256Hex(token));
      expect(rows[0]!.tokenHash).not.toBe(token);

      const dump = JSON.stringify(
        h.sql.exec(`SELECT * FROM member_invites`).toArray(),
      );
      expect(dump).not.toContain(token);

      expect(await h.vault.get<string>(`invite:${link.inviteId}`)).toBe(token);
    });
  });

  it("换绑邀请指向原成员的 userId", async () => {
    await withChannels("tools-rebind", async (h) => {
      const seeded = h.seed("小王", "rebind");
      const link = await h.runtime.rebindMember(OWNER, seeded.memberId);
      const row = h.sql
        .exec<{ kind: string; expected: string | null; target: string | null }>(
          `SELECT kind, expected_user_id AS expected, target_member_id AS target
           FROM member_invites WHERE id = ?`,
          link.inviteId,
        )
        .toArray()[0]!;
      expect(row.kind).toBe("rebind");
      expect(row.target).toBe(seeded.memberId);
      expect(row.expected).toBe("user-rebind");
      expect(link.bindUrl).toContain("/members/bind/#");
      expect(await h.vault.get<string>(`invite:${link.inviteId}`)).toBe(
        link.bindUrl.split("#")[1]!,
      );
    });
  });

  it("撤销的成员不能换绑，只能重新邀请", async () => {
    await withChannels("tools-rebind-revoked", async (h) => {
      const seeded = h.seed("小王", "revoked-rebind");
      await h.runtime.revokeMember(OWNER, seeded.memberId);
      await expect(
        h.runtime.rebindMember(OWNER, seeded.memberId),
      ).rejects.toThrow(MEMBER_ACCESS_DENIED);
    });
  });

  it("非主人调用每个管理 RPC 都被拒绝", async () => {
    await withChannels("tools-deny", async (h) => {
      const seeded = h.seed("小王", "deny");
      const spoofed = {
        memberId: seeded.memberId,
        role: "owner",
        epoch: 1,
      } as Principal;
      const link = await h.runtime.createMemberInvite(OWNER, "待取消");
      const attempts: [string, () => Promise<unknown>][] = [
        ["listMembers", () => h.runtime.listMembers(seeded.actor)],
        ["listMembers spoofed", () => h.runtime.listMembers(spoofed)],
        ["createMemberInvite", () => h.runtime.createMemberInvite(seeded.actor, "x")],
        ["createMemberInvite spoofed", () => h.runtime.createMemberInvite(spoofed, "x")],
        ["rebindMember", () => h.runtime.rebindMember(seeded.actor, seeded.memberId)],
        ["cancelMemberInvite", () => h.runtime.cancelMemberInvite(seeded.actor, link.inviteId)],
        ["revokeMember", () => h.runtime.revokeMember(seeded.actor, seeded.memberId)],
        ["revokeMember owner", () => h.runtime.revokeMember(OWNER, OWNER_ID)],
      ];
      for (const [label, attempt] of attempts) {
        await expect(attempt(), label).rejects.toThrow(MEMBER_ACCESS_DENIED);
      }
      // Nothing was revoked and the invite is still pending.
      const status = h.sql
        .exec<{ status: string }>(
          `SELECT status FROM member_invites WHERE id = ?`,
          link.inviteId,
        )
        .toArray()[0]!.status;
      expect(status).toBe("pending");
    });
  });

  it("取消邀请后 vault 里的入口令牌被删除", async () => {
    await withChannels("tools-cancel", async (h) => {
      const link = await h.runtime.createMemberInvite(OWNER, "取消");
      expect(await h.vault.get<string>(`invite:${link.inviteId}`)).toBeDefined();
      await h.runtime.cancelMemberInvite(OWNER, link.inviteId);
      const status = h.sql
        .exec<{ status: string }>(
          `SELECT status FROM member_invites WHERE id = ?`,
          link.inviteId,
        )
        .toArray()[0]!.status;
      expect(status).toBe("cancelled");
      expect(await h.vault.get<string>(`invite:${link.inviteId}`)).toBeUndefined();
    });
  });

  it("撤销成员清掉连接令牌但保留历史行", async () => {
    await withChannels("tools-revoke", async (h) => {
      const seeded = h.seed("小王", "revoke");
      await h.vault.put(seeded.credentialKey, { token: "FAKE_BOT_TOKEN" });
      await h.runtime.revokeMember(OWNER, seeded.memberId);

      expect(await h.vault.get(seeded.credentialKey)).toBeUndefined();
      const member = h.store.getMember(seeded.memberId);
      expect(member?.status).toBe("revoked");
      expect(h.store.getConnection(seeded.memberId)).toBeNull();
      const kept = h.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM member_connections WHERE member_id = ?`,
          seeded.memberId,
        )
        .toArray()[0]!.n;
      expect(kept).toBe(1);

      expect(() => h.store.assertActive(seeded.actor)).toThrow(
        MEMBER_ACCESS_DENIED,
      );
      await expect(h.runtime.listMembers(seeded.actor)).rejects.toThrow(
        MEMBER_ACCESS_DENIED,
      );
    });
  });

  it("成员列表只给出身份与状态，没有令牌或哈希", async () => {
    await withChannels("tools-list", async (h) => {
      const active = h.seed("小王", "list-a");
      const revoked = h.seed("小李", "list-b");
      await h.runtime.revokeMember(OWNER, revoked.memberId);

      const listed = await h.runtime.listMembers(OWNER);
      expect(listed.map((entry) => entry.memberId)).toContain(active.memberId);
      expect(
        listed.find((entry) => entry.memberId === revoked.memberId)?.status,
      ).toBe("revoked");

      const text = await runTool(
        createMemberTools({
          actor: OWNER,
          channel: h.runtime,
          locale: "zh",
        }),
        "list_members",
        {},
      );
      expect(text).toContain("小王");
      expect(text).toContain("小李");
      expect(text).toContain(t("zh", "member.list.revoked"));
      for (const secret of [
        "user-list-a",
        "wx-list-a",
        "credential-list-a",
        "FAKE_BOT_TOKEN",
      ]) {
        expect(text).not.toContain(secret);
      }
    });
  });
});

describe("member management tools", () => {
  it("只暴露五个主人工具", () => {
    const tools = createMemberTools({
      actor: OWNER,
      channel: {} as MemberAdminRpc,
      locale: "zh",
    });
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...MANAGEMENT_TOOLS].sort(),
    );
  });

  it("成员调用每个工具都被拒且打不到运行时", async () => {
    await withChannels("tools-member-actor", async (h) => {
      const seeded = h.seed("小王", "tool-actor");
      const { rpc, calls } = recording(h.runtime);
      const tools = createMemberTools({
        actor: seeded.actor,
        channel: rpc,
        locale: "zh",
      });
      const argumentsByName: Record<string, Record<string, unknown>> = {
        invite_member: { label: "小张" },
        rebind_member: { member_id: seeded.memberId },
        cancel_member_invite: { invite_id: "any" },
        list_members: {},
        revoke_member: { member_id: seeded.memberId },
      };
      for (const name of MANAGEMENT_TOOLS) {
        const text = await runTool(tools, name, argumentsByName[name]!);
        expect(text).toBe(t("zh", "member.denied"));
      }
      expect(calls).toEqual([]);
      // The spoofed owner role a model might pass travels in the arguments,
      // never in the actor: still nothing happened.
      const spoofed = await runTool(tools, "revoke_member", {
        member_id: seeded.memberId,
        role: "owner",
      });
      expect(spoofed).toBe(t("zh", "member.denied"));
      expect(calls).toEqual([]);
      expect(h.store.getMember(seeded.memberId)?.status).toBe("active");
    });
  });

  it("主人的邀请工具交回可转发的入口链接且不含二维码", async () => {
    await withChannels("tools-owner-invite", async (h) => {
      const tools = createMemberTools({
        actor: OWNER,
        channel: h.runtime,
        locale: "zh",
      });
      const text = await runTool(tools, "invite_member", { label: "小王" });
      const match = text.match(/https?:\/\/\S+\/members\/bind\/#([A-Za-z0-9_-]+)/);
      expect(match).not.toBeNull();
      const token = match![1]!;
      const rows = h.sql
        .exec<{ id: string; tokenHash: string | null }>(
          `SELECT id, token_hash AS tokenHash FROM member_invites`,
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).toBe(await sha256Hex(token));
      expect(await h.vault.get<string>(`invite:${rows[0]!.id}`)).toBe(token);
      expect(text.toLowerCase()).not.toContain("qrcode");
      expect(text).not.toContain("ticket");
      // 测试部署有真域名：用“转交链接”的主文案，不用本机专用文案。
      expect(text).toContain("原样转交");
      expect(text).not.toContain("实名二维码和家人的绑定二维码会随后直接发到这个聊天里");
    });
  });

  it("本机地址的邀请链接说明只能在部署所在机器打开", async () => {
    const link: MemberInviteLink = {
      inviteId: "invite-local",
      expiresAt: Date.now() + 10 * 60_000,
      bindUrl: "http://localhost:8787/members/bind/#token-token-token-token",
    };
    const channel = {
      createMemberInvite: async () => link,
    } as unknown as MemberAdminRpc;
    const text = await runTool(
      createMemberTools({ actor: OWNER, channel, locale: "zh" }),
      "invite_member",
      { label: "小王" },
    );
    expect(text).toContain(link.bindUrl);
    expect(text).toContain("实名二维码和家人的绑定二维码会随后直接发到这个聊天里");
    // 不再出现“把链接转交给受邀人”的矛盾指令。
    expect(text).not.toContain("原样转交");
  });

  it("成员对象的管理注册表里没有这些工具，主人对象有", async () => {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
    const seeded = await runInDurableObject(stub, async (_instance, state) => {
      const store = new MemberStore(state.storage.sql, undefined, (fn) =>
        state.storage.transactionSync(fn),
      );
      return seedMember(store, state.storage.sql, "注册表", "registry");
    });

    const memberStub = butler(butlerName(seeded.memberId));
    await memberStub.initializeMember(seeded.actor);
    const memberTools = await installedTools(memberStub);
    for (const name of MANAGEMENT_TOOLS) {
      expect(memberTools).not.toContain(name);
    }
    expect(memberTools).toContain("spawn_task");

    const ownerTools = await installedTools(butler("owner"));
    for (const name of MANAGEMENT_TOOLS) {
      expect(ownerTools).toContain(name);
    }
  });
});

describe("revocation cleanup", () => {
  it("撤销清空队列、上下文与待定重绑，且保留历史", async () => {
    const hub = env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
    const outcome = await runInDurableObject(hub, async (instance, state) => {
      const sql = state.storage.sql;
      const store = new MemberStore(sql, () => Date.now(), (fn) =>
        state.storage.transactionSync(fn),
      );
      const vault = new CredentialVault(state.storage);
      const connections = new ConnectionStore(sql, vault);
      settleForRevocation(sql);
      const raw = JSON.stringify({
        token: `revoke-${crypto.randomUUID()}`,
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: `acct-${crypto.randomUUID()}`,
        userId: `user-${crypto.randomUUID()}`,
      });
      const binding = {
        connectionId: `c-${crypto.randomUUID()}`,
        credentialKey: `credential-${crypto.randomUUID()}`,
        accountId: JSON.parse(raw).accountId,
        userId: JSON.parse(raw).userId,
        credentialHash: await sha256Hex(raw),
      };
      await vault.put(binding.credentialKey, raw);
      const invite = store.createInvite("撤销对象");
      const member = store.completeInvite(invite.inviteId, binding);
      connections.setConversation(binding.connectionId, binding.userId);
      await connections.writeContext(binding.connectionId, 1, "ctx-revoke");
      const rebind = store.createInvite("撤销对象", {
        kind: "rebind",
        targetMemberId: member.memberId,
      });
      await vault.put(inviteTokenKey(rebind.inviteId), "t".repeat(43));
      const queue = new OutboundQueue(sql, {
        connectionId: binding.connectionId,
        generation: 1,
      });
      queue.enqueue({ conversationId: binding.userId, text: "pending", buttons: null });

      const actor = store.principal(member.memberId)!;
      await (instance as unknown as {
        revokeMember(a: typeof actor, id: string): Promise<void>;
      }).revokeMember(ownerPrincipal(), member.memberId);

      let denied = false;
      try {
        store.assertActive(actor);
      } catch {
        denied = true;
      }
      return {
        denied,
        queue: queue.list().length,
        context: await connections.readContext(binding.connectionId, 1),
        credential: await vault.get(binding.credentialKey),
        token: await vault.get(inviteTokenKey(rebind.inviteId)),
        rebindStatus: store.getInvite(rebind.inviteId)?.status,
        memberRow: store.getMember(member.memberId)?.status,
      };
    });
    expect(outcome.denied).toBe(true);
    expect(outcome.queue).toBe(0);
    expect(outcome.context).toBeNull();
    expect(outcome.credential).toBeUndefined();
    expect(outcome.token).toBeUndefined();
    expect(outcome.rebindStatus).toBe("cancelled");
    // The history row stays; only access changed.
    expect(outcome.memberRow).toBe("revoked");
  });
});

function settleForRevocation(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO member_migrations (name, cursor, done, updated_at)
     VALUES ('legacy-inbox-owner', NULL, 1, 1)
     ON CONFLICT(name) DO UPDATE SET done = 1`,
  );
}
