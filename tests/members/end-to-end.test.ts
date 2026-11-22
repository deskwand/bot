import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setILinkFetchOverride,
  setMemberButlerOverride,
  setPollTimingOverride,
} from "../../src/channels/override";
import { sha256Hex } from "../../src/channels/route-identity";
import { ConnectionStore } from "../../src/channels/wechat/connections";
import {
  LEGACY_INBOX_MIGRATION,
  ensureMigrationTable,
} from "../../src/members/artifact-access";
import { CredentialVault, inviteTokenKey } from "../../src/members/credentials";
import { butlerName, ownerPrincipal, type Principal } from "../../src/members/principal";
import { MemberStore } from "../../src/members/store";
import { setModelOverride } from "../../src/llm/models";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const BASE = "https://ilinkai.weixin.qq.com";
let seq = 0;

function memberCreds(): { token: string; baseUrl: string; accountId: string; userId: string } {
  seq += 1;
  return {
    token: `e2e-token-${seq}`,
    baseUrl: BASE,
    accountId: `e2e-acct-${seq}`,
    userId: `e2e-user-${seq}`,
  };
}

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

function setEnv(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!savedEnv.has(key)) savedEnv.set(key, ENV[key]);
    ENV[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete ENV[key];
    else ENV[key] = value;
  }
  savedEnv.clear();
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

type Sent = { token: string; text: string };

/** One iLink stand-in: message batches per credential, sends recorded. */
function fakeIlink(state: {
  sent: Sent[];
  updates: Map<string, unknown>;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = (headers.Authorization ?? "").replace(/^Bearer /, "");
    if (url.endsWith("/ilink/bot/getupdates")) {
      return json(state.updates.get(token) ?? { ret: 0 });
    }
    if (url.endsWith("/ilink/bot/sendmessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        msg?: { item_list?: { text_item?: { text?: string } }[] };
      };
      state.sent.push({
        token,
        text: body.msg?.item_list?.[0]?.text_item?.text ?? "",
      });
      return json({ ret: 0 });
    }
    return json({ ret: 0 });
  }) as typeof fetch;
}

function settleInbox(sql: SqlStorage): void {
  ensureMigrationTable(sql);
  sql.exec(
    `INSERT INTO member_migrations (name, cursor, done, updated_at)
     VALUES (?, NULL, 1, ?)
     ON CONFLICT(name) DO UPDATE SET done = 1, updated_at = excluded.updated_at`,
    LEGACY_INBOX_MIGRATION,
    Date.now(),
  );
}

afterEach(() => {
  setILinkFetchOverride(null);
  setMemberButlerOverride(null);
  setPollTimingOverride(null);
  setModelOverride(null);
  restoreEnv();
  vi.restoreAllMocks();
});

describe("invite → bind → work → revoke", () => {
  it("主人发出邀请后成员独立办事，撤销后彻底无法再用", async () => {
    const state = { sent: [] as Sent[], updates: new Map<string, unknown>() };
    setILinkFetchOverride(fakeIlink(state));
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    setPollTimingOverride({ runMs: 0, baseBackoffMs: 1, manualStart: true });

    const hub = env.CHANNELS.get(env.CHANNELS.idFromName("channels"));

    // 1. The owner invites; the link carries a token, SQL only its digest.
    const invite = await runInDurableObject(hub, async (instance, store) => {
      const sql = store.storage.sql;
      settleInbox(sql);
      const memberStore = new MemberStore(sql, () => Date.now(), (fn) =>
        store.storage.transactionSync(fn),
      );
      memberStore.ensureOwner();
      void instance;
      const link = await (instance as unknown as {
        createMemberInvite(actor: Principal, label: string): Promise<{
          inviteId: string;
          expiresAt: number;
          bindUrl: string;
        }>;
      }).createMemberInvite(ownerPrincipal(), "小林");
      const token = link.bindUrl.split("#")[1]!;
      const rows = sql
        .exec<{ token_hash: string | null }>(
          `SELECT token_hash FROM member_invites WHERE id = ?`,
          link.inviteId,
        )
        .toArray();
      const vault = new CredentialVault(store.storage);
      return {
        inviteId: link.inviteId,
        token,
        sqlHash: rows[0]?.token_hash,
        vaultToken: await vault.get(inviteTokenKey(link.inviteId)),
        expectedHash: await sha256Hex(token),
      };
    });
    expect(invite.token.length).toBeGreaterThanOrEqual(43);
    expect(invite.sqlHash).toBe(invite.expectedHash);
    expect(invite.sqlHash).not.toBe(invite.token);
    expect(invite.vaultToken).toBe(invite.token);

    // 2. The invite page sees only the invite's own stage.
    const page = await runInDurableObject(hub, (instance) =>
      (instance as unknown as {
        memberBindState(token: string): Promise<{ ok: boolean; view?: { stage: string } }>;
      }).memberBindState(invite.token),
    );
    expect(page.ok).toBe(true);
    expect(["idle", "realname", "scan"]).toContain(page.view?.stage);

    // 3. The WeChat account confirms; the same code path the login machine
    //    uses activates the connection.
    const creds = memberCreds();
    const raw = JSON.stringify(creds);
    const activation = await runInDurableObject(hub, async (instance, store) => {
      const sql = store.storage.sql;
      const memberStore = new MemberStore(sql, () => Date.now(), (fn) =>
        store.storage.transactionSync(fn),
      );
      const vault = new CredentialVault(store.storage);
      const connections = new ConnectionStore(sql, vault);
      const credentialKey = `credential-${invite.inviteId}`;
      await vault.put(credentialKey, raw);
      const member = memberStore.completeInvite(invite.inviteId, {
        connectionId: invite.inviteId,
        credentialKey,
        accountId: creds.accountId,
        userId: creds.userId,
        credentialHash: await sha256Hex(raw),
      });
      connections.setConversation(invite.inviteId, creds.userId);
      await connections.writeContext(invite.inviteId, 1, `ctx-${invite.inviteId}`);
      void instance;
      return member;
    });
    expect(activation.role).toBe("member");

    const actor = await runInDurableObject(hub, (_i, store) =>
      new MemberStore(store.storage.sql).principal(activation.memberId),
    );
    expect(actor?.role).toBe("member");

    // 4. The member sends one ordinary message; the channel hands it to the
    //    member's own Butler with the trusted actor, and to nobody else.
    const dispatched: { actor?: string; member: string; text: string | null }[] = [];
    setMemberButlerOverride({
      async initializeMember(initActor) {
        dispatched.push({ actor: initActor.memberId, member: "init", text: null });
      },
      async handleMessage(message) {
        dispatched.push({
          actor: message.actor?.memberId,
          member: message.actor?.memberId ?? "unknown",
          text: message.text,
        });
      },
    });
    state.updates.set(creds.token, {
      ret: 0,
      get_updates_buf: "cursor-1",
      msgs: [
        {
          message_id: 7,
          from_user_id: creds.userId,
          message_type: 1,
          context_token: `ctx-${invite.inviteId}`,
          item_list: [{ type: 1, text_item: { text: "帮我查北京天气" } }],
        },
      ],
    });
    await runInDurableObject(hub, (instance) =>
      (instance as unknown as {
        pollMemberWeChat(payload: { connectionId: string; generation: number }): Promise<void>;
      }).pollMemberWeChat({ connectionId: invite.inviteId, generation: 1 }),
    );
    await vi.waitFor(
      async () =>
        expect(dispatched.some((entry) => entry.text === "帮我查北京天气")).toBe(
          true,
        ),
      { timeout: 10_000, interval: 100 },
    );
    expect(dispatched.every((entry) => entry.actor === activation.memberId)).toBe(
      true,
    );

    // 5. Revocation retires access, credentials and queued chat.
    const revoked = await runInDurableObject(hub, async (instance, store) => {
      await (instance as unknown as {
        revokeMember(actor: Principal, memberId: string): Promise<void>;
      }).revokeMember(ownerPrincipal(), activation.memberId);
      const session = new MemberStore(store.storage.sql);
      let denied = false;
      try {
        session.assertActive(actor!);
      } catch {
        denied = true;
      }
      const vault = new CredentialVault(store.storage);
      return {
        denied,
        credential: await vault.get(`credential-${invite.inviteId}`),
      };
    });
    expect(revoked.denied).toBe(true);
    expect(revoked.credential).toBeUndefined();

    // Nothing the member's credential could send is admitted any more.
    state.updates.set(creds.token, {
      ret: 0,
      msgs: [
        {
          message_id: 8,
          from_user_id: creds.userId,
          message_type: 1,
          item_list: [{ type: 1, text_item: { text: "还在吗" } }],
        },
      ],
    });
    await runInDurableObject(hub, (instance) =>
      (instance as unknown as {
        pollMemberWeChat(payload: { connectionId: string; generation: number }): Promise<void>;
      }).pollMemberWeChat({ connectionId: invite.inviteId, generation: 1 }),
    );
    // The revoked connection is not polled at all; nothing else is admitted.
    const dispatchedAfter = dispatched.length;
    await runInDurableObject(hub, (instance) =>
      (instance as unknown as {
        pollMemberWeChat(payload: { connectionId: string; generation: number }): Promise<void>;
      }).pollMemberWeChat({ connectionId: invite.inviteId, generation: 1 }),
    );
    expect(dispatched.length).toBe(dispatchedAfter);
  }, 30_000);
});

describe("operator link delivery", () => {
  it("解开实名 CGI 的 data 信封，并把链接作为系统消息送进主人聊天", async () => {
    const authUrl = "https://liteapp.weixin.qq.com/q/e2e-realname";
    let qrRequests = 0;
    setILinkFetchOverride((async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("step=get_auth_url")) {
        return json({
          ret: 0,
          data: {
            auth_url: authUrl,
            bot_spam_ticket: "spam-ticket-e2e",
            expire_time: 1_795_428_630,
          },
        });
      }
      if (url.includes("step=query_auth_result")) {
        return json({ ret: 0, data: { auth_status: 1 } });
      }
      if (url.includes("/ilink/bot/get_bot_qrcode")) {
        qrRequests += 1;
        return json({
          qrcode: "qr-e2e",
          qrcode_img_content: "https://weixin.qq.com/qr/e2e",
        });
      }
      return json({ ret: 0 });
    }) as typeof fetch);
    setEnv({ ACTIVE_CHANNEL: "wechat" });

    const hub = env.CHANNELS.get(env.CHANNELS.idFromName("channels-realname"));

    const result = await runInDurableObject(hub, async (instance, store) => {
      settleInbox(store.storage.sql);
      const sent: string[] = [];
      const images: { name: string; bytes: Uint8Array }[] = [];
      const sendCurrent = vi
        .spyOn(instance, "sendCurrent")
        .mockImplementation(async (message) => {
          sent.push(message.text);
          return {
            channel: "wechat",
            conversationId: "owner-conversation",
            routeKey: "wechat",
            messageId: null,
          };
        });
      const sendOwnerImage = vi
        .spyOn(
          instance as unknown as {
            sendOwnerImage(name: string, bytes: Uint8Array): Promise<void>;
          },
          "sendOwnerImage",
        )
        .mockImplementation(async (name, bytes) => {
          images.push({ name, bytes });
        });
      const link = await (instance as unknown as {
        createMemberInvite(
          actor: Principal,
          label: string,
        ): Promise<{ inviteId: string; bindUrl: string }>;
      }).createMemberInvite(ownerPrincipal(), "小林");
      await (instance as unknown as {
        pollMemberLogin(payload: {
          inviteId: string;
          generation: number;
        }): Promise<void>;
      }).pollMemberLogin({ inviteId: link.inviteId, generation: 1 });
      const page = await (instance as unknown as {
        memberBindState(
          token: string,
        ): Promise<{ ok: boolean; view?: { stage: string } }>;
      }).memberBindState(link.bindUrl.split("#")[1]!);
      sendCurrent.mockRestore();
      sendOwnerImage.mockRestore();
      return { sent, images, stage: page.view?.stage };
    });

    // 两个码都以图片送达：实名一张、绑定一张，都是可扫的 PNG。
    expect(result.images.map((image) => image.name)).toEqual([
      "wechat-realname.png",
      "wechat-bind.png",
    ]);
    for (const image of result.images) {
      expect([...image.bytes.subarray(0, 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
    }

    // 文本只说明怎么用，不再把链接当可点地址交付。
    expect(result.sent).toHaveLength(2);
    expect(result.sent[0]).not.toContain("http");
    expect(result.sent[1]).not.toContain("http");
    expect(result.stage).toBe("scan");
    expect(qrRequests).toBe(1);
  }, 30_000);
});
