import { createCipheriv } from "node:crypto";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactStore } from "../../src/artifact-store";
import { AttachmentAccess } from "../../src/members/artifact-access";
import {
  setILinkFetchOverride,
  setMemberButlerOverride,
  setPollTimingOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import { sha256Hex } from "../../src/channels/route-identity";
import { ConnectionStore } from "../../src/channels/wechat/connections";
import {
  LEGACY_INBOX_MIGRATION,
  ensureMigrationTable,
} from "../../src/members/artifact-access";
import { CredentialVault } from "../../src/members/credentials";
import { OWNER_ID, type ConnectionRef, type Principal } from "../../src/members/principal";
import {
  MEMBER_ACCESS_DENIED,
  MemberStore,
  type MemberView,
  type VerifiedBinding,
} from "../../src/members/store";
import type {
  AdmittedMessage,
  ChannelMessageRef,
  MessageEvent,
  RouteSnapshot,
} from "../../src/protocol";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const BASE_URL = "https://ilinkai.weixin.qq.com";

const CREDS_A = {
  token: "token-a",
  baseUrl: BASE_URL,
  accountId: "account-a",
  userId: "user-a",
};

const CREDS_B = {
  token: "token-b",
  baseUrl: BASE_URL,
  accountId: "account-b",
  userId: "user-b",
};

/** The narrow runtime surface this suite exercises on a real ChannelDO. */
type MemberRuntime = {
  assertMemberActive(actor: Principal): Promise<void>;
  memberPrincipal(memberId: string): Promise<Principal | null>;
  memberIds(): Promise<string[]>;
  listMembers(actor: Principal): Promise<MemberView[]>;
  routeForMember(actor: Principal): Promise<RouteSnapshot>;
  isMemberAdmissionCurrent(
    actor: Principal,
    channel: "wechat",
    ref: ConnectionRef,
    routeKey: string,
  ): Promise<boolean>;
  sendToMember(
    actor: Principal,
    message: { text: string },
  ): Promise<ChannelMessageRef>;
  pollMemberWeChat(payload: {
    connectionId: string;
    generation: number;
  }): Promise<void>;
  currentRoute(): Promise<RouteSnapshot>;
};

type RecordedCall = {
  url: string;
  token: string;
  body: Record<string, unknown> | undefined;
};

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FakeIlink = {
  calls: RecordedCall[];
  /** Replies for `getupdates`, chosen by the credential's bearer token. */
  batches: Map<string, unknown>;
  /** Credentials whose `sendmessage` is rejected. */
  failSend: Set<string>;
  /** CDN bodies by `encrypted_query_param`, as the download endpoint saw them. */
  cdn: Map<string, Uint8Array>;
  /** Runs while a CDN download is in flight (e.g. to revoke the member). */
  onDownload: (() => Promise<void> | void) | null;
};

const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const KEY_HEX = "00112233445566778899aabbccddeeff";
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mM4YWODFTEMLQkAZZlQAS/gME0AAAAASUVORK5CYII=";
const PNG = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
/** The same PNG as iLink ships an encrypted image. */
function encryptedPng(): Uint8Array {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(KEY_HEX, "hex"), null);
  return new Uint8Array(Buffer.concat([cipher.update(PNG), cipher.final()]));
}

/**
 * An iLink stand-in that answers by credential, never by connection name: the
 * production code must pick the right credential for itself.
 */
function fakeIlink(): FakeIlink & { fetch: typeof fetch } {
  const calls: RecordedCall[] = [];
  const batches = new Map<string, unknown>();
  const failSend = new Set<string>();
  const cdn = new Map<string, Uint8Array>();
  const state: { onDownload: (() => Promise<void> | void) | null } = {
    onDownload: null,
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(`${CDN_BASE}/download`)) {
      if (state.onDownload !== null) await state.onDownload();
      const param = new URL(url).searchParams.get("encrypted_query_param") ?? "";
      return new Response(cdn.get(param) ?? new Uint8Array(), { status: 200 });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = (headers.Authorization ?? "").replace(/^Bearer /, "");
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ url, token, body });

    if (url.endsWith("/ilink/bot/getupdates")) {
      const reply = batches.get(token);
      return jsonResponse(reply ?? { ret: 0 });
    }
    if (url.endsWith("/ilink/bot/sendmessage")) {
      if (failSend.has(token)) {
        return jsonResponse({ errcode: 40001, errmsg: "send failed" }, 500);
      }
      return jsonResponse({ ret: 0 });
    }
    return jsonResponse({ ret: 0 });
  }) as typeof fetch;
  const handle: FakeIlink & { fetch: typeof fetch } = {
    calls,
    batches,
    failSend,
    cdn,
    get onDownload() {
      return state.onDownload;
    },
    set onDownload(value) {
      state.onDownload = value;
    },
    fetch: fetchImpl,
  };
  return handle;
}

/** One media message as iLink ships it, with an optional caption. */
function mediaMessage(
  messageId: string,
  fromUserId: string,
  items: unknown[],
  text: string | null = null,
) {
  return {
    message_id: messageId,
    from_user_id: fromUserId,
    message_type: 1,
    context_token: `ctx-${fromUserId}`,
    item_list:
      text === null
        ? items
        : [{ type: 1, text_item: { text } }, ...items],
  };
}

function imageItem(param: string) {
  return {
    type: 2,
    image_item: { media: { encrypt_query_param: param }, aeskey: KEY_HEX },
  };
}

function fileItem(param: string, name: string) {
  return {
    type: 4,
    file_item: { media: { encrypt_query_param: param }, file_name: name },
  };
}

/** One text message as iLink ships it (item type 1 is text). */
function textMessage(messageId: string, fromUserId: string, text: string) {
  return {
    message_id: messageId,
    from_user_id: fromUserId,
    message_type: 1,
    context_token: `ctx-${fromUserId}`,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

/**
 * A fixture DO is booted by the production class, so its legacy tables may
 * exist and leave the inbox question open. Settle it the way a completed boot
 * does, otherwise member activation stays gated.
 */
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

type Seeded = {
  store: MemberStore;
  connections: ConnectionStore;
  actorA: Principal;
  actorB: Principal;
  memberA: MemberView;
  memberB: MemberView;
  refA: ConnectionRef;
  refB: ConnectionRef;
};

/** Two members with their own credential, connection row and conversation. */
async function seedMembers(
  state: DurableObjectState,
): Promise<Seeded> {
  const sql = state.storage.sql;
  settleInbox(sql);
  const store = new MemberStore(sql, () => Date.now(), (fn) =>
    state.storage.transactionSync(fn),
  );
  const vault = new CredentialVault(state.storage);
  const connections = new ConnectionStore(sql, vault);

  const rawA = JSON.stringify(CREDS_A);
  const rawB = JSON.stringify(CREDS_B);
  const bindingA: VerifiedBinding = {
    connectionId: "c-a",
    credentialKey: "credential-a-op1",
    accountId: CREDS_A.accountId,
    userId: CREDS_A.userId,
    credentialHash: await sha256Hex(rawA),
  };
  const bindingB: VerifiedBinding = {
    connectionId: "c-b",
    credentialKey: "credential-b-op1",
    accountId: CREDS_B.accountId,
    userId: CREDS_B.userId,
    credentialHash: await sha256Hex(rawB),
  };

  await vault.put(bindingA.credentialKey, rawA);
  await vault.put(bindingB.credentialKey, rawB);

  const inviteA = store.createInvite("A");
  const memberA = store.completeInvite(inviteA.inviteId, bindingA);
  const inviteB = store.createInvite("B");
  const memberB = store.completeInvite(inviteB.inviteId, bindingB);

  connections.setConversation(bindingA.connectionId, CREDS_A.userId);
  connections.setConversation(bindingB.connectionId, CREDS_B.userId);

  const actorA = store.principal(memberA.memberId);
  const actorB = store.principal(memberB.memberId);
  if (!actorA || !actorB) throw new Error("fixture: principal missing");

  return {
    store,
    connections,
    actorA,
    actorB,
    memberA,
    memberB,
    refA: {
      memberId: memberA.memberId,
      connectionId: bindingA.connectionId,
      generation: 1,
    },
    refB: {
      memberId: memberB.memberId,
      connectionId: bindingB.connectionId,
      generation: 1,
    },
  };
}

function channelStub(name: string) {
  return env.CHANNELS.get(
    env.CHANNELS.idFromName(`${name}-${crypto.randomUUID()}`),
  );
}

/** Lets the ctx.waitUntil dispatch chain finish inside the test. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

let hubName = "";

function hub() {
  return env.CHANNELS.get(env.CHANNELS.idFromName(hubName));
}

beforeEach(() => {
  hubName = `member-admission-${crypto.randomUUID()}`;
  setEnv({ ACTIVE_CHANNEL: "wechat" });
  setWeChatCredentialsOverride(null);
  // Tests drive pollMemberWeChat themselves; a scheduled chain would race the
  // scripted fetch installed between two calls.
  setPollTimingOverride({ runMs: 0, baseBackoffMs: 1, manualStart: true });
});

afterEach(() => {
  setILinkFetchOverride(null);
  setMemberButlerOverride(null);
  setPollTimingOverride(null);
  setWeChatCredentialsOverride(null);
  restoreEnv();
});

describe("ChannelDO member runtime", () => {
  it("两个连接的游标、事件 id 与 actor 互不干扰", async () => {
    const ilink = fakeIlink();
    ilink.batches.set(
      CREDS_A.token,
      {
        ret: 0,
        get_updates_buf: "a-next",
        msgs: [textMessage("same", CREDS_A.userId, "来自 A")],
      },
    );
    ilink.batches.set(
      CREDS_B.token,
      {
        ret: 0,
        get_updates_buf: "b-next",
        msgs: [textMessage("same", CREDS_B.userId, "来自 B")],
      },
    );
    setILinkFetchOverride(ilink.fetch);

    const delivered: AdmittedMessage[] = [];
    const initialised: Principal[] = [];
    setMemberButlerOverride({
      initializeMember: async (actor) => {
        initialised.push(actor);
      },
      handleMessage: async (message) => {
        delivered.push(message);
      },
    });

    await runInDurableObject(hub(), async (instance, state) => {
      const seeded = await seedMembers(state);
      const runtime = instance as unknown as MemberRuntime;

      await runtime.pollMemberWeChat({ connectionId: "c-a", generation: 1 });
      await runtime.pollMemberWeChat({ connectionId: "c-b", generation: 1 });
      await settle();

      const cursors = state.storage.sql
        .exec<{ id: string; cursor: string }>(
          `SELECT id, cursor FROM member_connections ORDER BY id`,
        )
        .toArray();
      expect(cursors).toEqual([
        { id: "c-a", cursor: "a-next" },
        { id: "c-b", cursor: "b-next" },
      ]);

      // Same upstream message id, two independent event ids and actors.
      expect(delivered.map((message) => message.eventId)).toEqual([
        "wx:c-a:same",
        "wx:c-b:same",
      ]);
      expect(delivered.map((message) => message.actor?.memberId)).toEqual([
        seeded.memberA.memberId,
        seeded.memberB.memberId,
      ]);
      expect(delivered.map((message) => message.connectionRef?.connectionId)).toEqual([
        "c-a",
        "c-b",
      ]);
      expect(initialised.map((actor) => actor.memberId)).toEqual([
        seeded.memberA.memberId,
        seeded.memberB.memberId,
      ]);

      // A member's inbound is written to its own conversation, never the
      // owner address book.
      expect(
        state.storage.sql.exec(`SELECT * FROM owner_addresses`).toArray(),
      ).toEqual([]);
      const conversations = state.storage.sql
        .exec<{ id: string; conversation_id: string }>(
          `SELECT id, conversation_id FROM member_connections ORDER BY id`,
        )
        .toArray();
      expect(conversations).toEqual([
        { id: "c-a", conversation_id: "user-a" },
        { id: "c-b", conversation_id: "user-b" },
      ]);

      // The context token is in the vault, not in SQL.
      const rows = state.storage.sql
        .exec(`SELECT * FROM member_connections`)
        .toArray();
      expect(JSON.stringify(rows)).not.toContain("ctx-");
    });
  });

  it("A 的会话过期不影响 B，且只改自己那一行", async () => {
    const ilink = fakeIlink();
    ilink.batches.set(CREDS_A.token, {
      errcode: -14,
      errmsg: "session expired",
    });
    ilink.batches.set(CREDS_B.token, {
      ret: 0,
      get_updates_buf: "b-next",
      msgs: [textMessage("m-b", CREDS_B.userId, "B 正常")],
    });
    setILinkFetchOverride(ilink.fetch);

    const delivered: AdmittedMessage[] = [];
    setMemberButlerOverride({
      initializeMember: async () => undefined,
      handleMessage: async (message) => {
        delivered.push(message);
      },
    });

    await runInDurableObject(hub(), async (instance, state) => {
      await seedMembers(state);
      const runtime = instance as unknown as MemberRuntime;

      await runtime.pollMemberWeChat({ connectionId: "c-a", generation: 1 });
      await runtime.pollMemberWeChat({ connectionId: "c-b", generation: 1 });
      await settle();

      const rows = state.storage.sql
        .exec<{ id: string; poll_status: string; cursor: string }>(
          `SELECT id, poll_status, cursor FROM member_connections ORDER BY id`,
        )
        .toArray();
      expect(rows).toEqual([
        { id: "c-a", poll_status: "expired", cursor: "" },
        { id: "c-b", poll_status: "polling", cursor: "b-next" },
      ]);
      // Only B's message reached the Butler boundary.
      expect(delivered.map((message) => message.eventId)).toEqual([
        "wx:c-b:m-b",
      ]);
    });
  });

  it("主人路由已缓存时成员仍拿到自己的路由", async () => {
    await runInDurableObject(hub(), async (instance, state) => {
      const seeded = await seedMembers(state);
      const runtime = instance as unknown as MemberRuntime;

      // The owner route is cached first: a member must not depend on it.
      const ownerRoute = await runtime.currentRoute();
      const routeA = await runtime.routeForMember(seeded.actorA);
      expect(routeA.channel).toBe("wechat");
      expect(routeA.routeKey).not.toBe(ownerRoute.routeKey);
      expect(
        await runtime.isMemberAdmissionCurrent(
          seeded.actorA,
          "wechat",
          seeded.refA,
          routeA.routeKey,
        ),
      ).toBe(true);
      expect(
        await runtime.isMemberAdmissionCurrent(
          seeded.actorA,
          "wechat",
          seeded.refA,
          ownerRoute.routeKey,
        ),
      ).toBe(false);
    });
  });

  it("A 的 actor 搭配 B 的 ref 或 routeKey 被拒", async () => {
    await runInDurableObject(hub(), async (instance, state) => {
      const seeded = await seedMembers(state);
      const runtime = instance as unknown as MemberRuntime;
      const routeA = await runtime.routeForMember(seeded.actorA);
      const routeB = await runtime.routeForMember(seeded.actorB);

      expect(routeA.routeKey).not.toBe(routeB.routeKey);
      expect(
        await runtime.isMemberAdmissionCurrent(
          seeded.actorA,
          "wechat",
          seeded.refB,
          routeB.routeKey,
        ),
      ).toBe(false);
      expect(
        await runtime.isMemberAdmissionCurrent(
          seeded.actorA,
          "wechat",
          seeded.refB,
          routeA.routeKey,
        ),
      ).toBe(false);
      expect(
        await runtime.isMemberAdmissionCurrent(
          seeded.actorB,
          "wechat",
          seeded.refB,
          routeB.routeKey,
        ),
      ).toBe(true);
    });
  });

  it("成员入站不改主人地址簿，成员发送只走自己的凭据与地址", async () => {
    const ilink = fakeIlink();
    ilink.batches.set(CREDS_A.token, {
      ret: 0,
      get_updates_buf: "a-next",
      msgs: [textMessage("m-a", CREDS_A.userId, "你好")],
    });
    setILinkFetchOverride(ilink.fetch);
    setMemberButlerOverride({
      initializeMember: async () => undefined,
      handleMessage: async () => undefined,
    });

    await runInDurableObject(hub(), async (instance, state) => {
      const seeded = await seedMembers(state);
      const runtime = instance as unknown as MemberRuntime;
      // The directory's owner row exists but the address book stays empty.
      expect(
        state.storage.sql.exec(`SELECT * FROM owner_addresses`).toArray(),
      ).toEqual([]);

      await runtime.pollMemberWeChat({ connectionId: "c-a", generation: 1 });
      await settle();

      ilink.calls.length = 0;
      await runtime.sendToMember(seeded.actorA, { text: "成员回复" });
      await settle();

      const sends = ilink.calls.filter((call) =>
        call.url.endsWith("/ilink/bot/sendmessage"),
      );
      expect(sends).toHaveLength(1);
      expect(sends[0].token).toBe(CREDS_A.token);
      const msg = sends[0].body?.msg as {
        to_user_id: string;
        context_token: string;
      };
      expect(msg.to_user_id).toBe(CREDS_A.userId);
      expect(msg.context_token).toBe(`ctx-${CREDS_A.userId}`);

      // Still no owner address, and the queue drained.
      expect(
        state.storage.sql.exec(`SELECT * FROM owner_addresses`).toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql.exec(`SELECT * FROM outbound_queue`).toArray(),
      ).toEqual([]);
    });
  });

  it("A 的队列发送失败不删除也不阻塞 B 的队列", async () => {
    const ilink = fakeIlink();
    ilink.batches.set(CREDS_A.token, {
      ret: 0,
      get_updates_buf: "a-next",
      msgs: [textMessage("m-a", CREDS_A.userId, "你好")],
    });
    ilink.batches.set(CREDS_B.token, {
      ret: 0,
      get_updates_buf: "b-next",
      msgs: [textMessage("m-b", CREDS_B.userId, "你好")],
    });
    ilink.failSend.add(CREDS_A.token);
    setILinkFetchOverride(ilink.fetch);
    setMemberButlerOverride({
      initializeMember: async () => undefined,
      handleMessage: async () => undefined,
    });

    await runInDurableObject(hub(), async (instance, state) => {
      const seeded = await seedMembers(state);
      const runtime = instance as unknown as MemberRuntime;

      await runtime.pollMemberWeChat({ connectionId: "c-a", generation: 1 });
      await runtime.pollMemberWeChat({ connectionId: "c-b", generation: 1 });
      await settle();

      // A is rejected and stays queued; B is unaffected.
      await runtime.sendToMember(seeded.actorA, { text: "A 的消息" });
      await runtime.sendToMember(seeded.actorB, { text: "B 的消息" });
      await settle();

      const rows = state.storage.sql
        .exec<{
          connection_id: string;
          text: string;
          last_error: string | null;
        }>(
          `SELECT connection_id, text, last_error FROM outbound_queue
           ORDER BY id`,
        )
        .toArray();
      expect(rows).toEqual([
        {
          connection_id: "c-a",
          text: "A 的消息",
          last_error: "upstream_error",
        },
      ]);

      // A's send was attempted against A's own credential and address and was
      // rejected; B's send succeeded independently.
      const sentTo = ilink.calls
        .filter((call) => call.url.endsWith("/ilink/bot/sendmessage"))
        .map((call) => ({
          token: call.token,
          to: (call.body?.msg as { to_user_id: string }).to_user_id,
        }));
      expect(sentTo).toEqual([
        { token: CREDS_A.token, to: CREDS_A.userId },
        { token: CREDS_B.token, to: CREDS_B.userId },
      ]);
    });
  });

  it("撤销后不再被接纳，发送被拒，但目录仍列出该成员", async () => {
    await runInDurableObject(hub(), async (instance, state) => {
      const seeded = await seedMembers(state);
      const runtime = instance as unknown as MemberRuntime;
      const routeA = await runtime.routeForMember(seeded.actorA);

      seeded.store.revoke(seeded.memberA.memberId);

      expect(
        await runtime.isMemberAdmissionCurrent(
          seeded.actorA,
          "wechat",
          seeded.refA,
          routeA.routeKey,
        ),
      ).toBe(false);
      await expect(
        runtime.assertMemberActive(seeded.actorA),
      ).rejects.toThrow(MEMBER_ACCESS_DENIED);
      await expect(
        runtime.sendToMember(seeded.actorA, { text: "撤销后" }),
      ).rejects.toThrow(MEMBER_ACCESS_DENIED);
      // A retired connection has no route at all.
      await expect(runtime.routeForMember(seeded.actorA)).rejects.toThrow(
        MEMBER_ACCESS_DENIED,
      );

      // Revoked members stay visible to the owner directory.
      expect(await runtime.memberIds()).toContain(seeded.memberA.memberId);
      const owner = await runtime.memberPrincipal(OWNER_ID);
      if (!owner) throw new Error("fixture: owner missing");
      const listed = await runtime.listMembers(owner);
      expect(
        listed.find((member) => member.memberId === seeded.memberA.memberId)
          ?.status,
      ).toBe("revoked");

      // Only the owner may read the directory.
      await expect(runtime.listMembers(seeded.actorB)).rejects.toThrow(
        MEMBER_ACCESS_DENIED,
      );
      expect((await runtime.memberIds()).sort()).toEqual(
        [seeded.memberA.memberId, seeded.memberB.memberId].sort(),
      );
    });
  });

  it("旧 generation 的回调不能读或推进新连接的游标", async () => {
    const ilink = fakeIlink();
    ilink.batches.set(CREDS_A.token, {
      ret: 0,
      get_updates_buf: "a-next",
      msgs: [textMessage("m-a", CREDS_A.userId, "你好")],
    });
    setILinkFetchOverride(ilink.fetch);
    setMemberButlerOverride({
      initializeMember: async () => undefined,
      handleMessage: async () => undefined,
    });

    await runInDurableObject(hub(), async (instance, state) => {
      await seedMembers(state);
      const runtime = instance as unknown as MemberRuntime;
      // Rebind: generation 2 replaces generation 1.
      state.storage.sql.exec(
        `UPDATE member_connections SET generation = 2 WHERE id = 'c-a'`,
      );

      await runtime.pollMemberWeChat({ connectionId: "c-a", generation: 1 });
      await settle();

      expect(ilink.calls).toEqual([]);
      const row = state.storage.sql
        .exec<{ cursor: string }>(
          `SELECT cursor FROM member_connections WHERE id = 'c-a'`,
        )
        .toArray()[0];
      expect(row.cursor).toBe("");
    });
  });

  it("ACTIVE_CHANNEL 不是微信时不轮询成员连接", async () => {
    setEnv({ ACTIVE_CHANNEL: "telegram" });
    const ilink = fakeIlink();
    setILinkFetchOverride(ilink.fetch);

    await runInDurableObject(hub(), async (instance, state) => {
      await seedMembers(state);
      const runtime = instance as unknown as MemberRuntime;
      await runtime.pollMemberWeChat({ connectionId: "c-a", generation: 1 });
    });

    expect(ilink.calls).toEqual([]);
  });
  it("成员图片与文件存入成员自己的命名空间，归属成员而非主人", async () => {
    const ilink = fakeIlink();
    ilink.cdn.set("img-a", encryptedPng());
    ilink.cdn.set("file-a", new TextEncoder().encode("hello"));
    ilink.batches.set(CREDS_A.token, {
      ret: 0,
      get_updates_buf: "a-next",
      msgs: [
        mediaMessage("m-img", CREDS_A.userId, [imageItem("img-a")]),
        mediaMessage("m-file", CREDS_A.userId, [fileItem("file-a", "notes.txt")]),
      ],
    });
    setILinkFetchOverride(ilink.fetch);

    const delivered: AdmittedMessage[] = [];
    setMemberButlerOverride({
      initializeMember: async () => undefined,
      handleMessage: async (message) => {
        delivered.push(message);
      },
    });

    await runInDurableObject(hub(), async (instance, state) => {
      const seeded = await seedMembers(state);
      const runtime = instance as unknown as MemberRuntime;

      await runtime.pollMemberWeChat({ connectionId: "c-a", generation: 1 });
      await settle();

      // Both media items reached the member's Butler with A's actor and ref,
      // under event ids namespaced by A's own connection.
      expect(delivered.map((message) => message.eventId)).toEqual([
        "wx:c-a:m-img",
        "wx:c-a:m-file",
      ]);
      expect(delivered.map((message) => message.actor?.memberId)).toEqual([
        seeded.memberA.memberId,
        seeded.memberA.memberId,
      ]);
      expect(
        delivered.map((message) => message.connectionRef?.connectionId),
      ).toEqual(["c-a", "c-a"]);

      const imageKey = delivered[0].files?.[0]?.key;
      const fileKey = delivered[1].files?.[0]?.key;
      if (!imageKey || !fileKey) throw new Error("fixture: files missing");
      expect(imageKey.startsWith("inbox/wx:c-a:m-img/")).toBe(true);
      expect(fileKey).toBe("inbox/wx:c-a:m-file/notes.txt");
      expect(delivered[0].images).toHaveLength(1);

      const attachments = new AttachmentAccess(state.storage.sql);
      for (const key of [imageKey, fileKey]) {
        expect(attachments.owns(seeded.memberA.memberId, key)).toBe(true);
        // The owner neither owns nor may adopt the member's bytes.
        expect(attachments.owns(OWNER_ID, key)).toBe(false);
        expect(() => attachments.record(OWNER_ID, key)).toThrow(
          "ATTACHMENT_OWNED_BY_OTHER",
        );
        expect(await artifactStore(env).get(key)).not.toBeNull();
      }

      const owners = state.storage.sql
        .exec<{ key: string; member_id: string }>(
          `SELECT key, member_id FROM attachment_owners ORDER BY key`,
        )
        .toArray();
      expect(owners).toEqual([
        { key: fileKey, member_id: seeded.memberA.memberId },
        { key: imageKey, member_id: seeded.memberA.memberId },
      ]);
      // No owner address and no B-side row was written by A's media.
      expect(
        state.storage.sql.exec(`SELECT * FROM owner_addresses`).toArray(),
      ).toEqual([]);
      expect(
        state.storage.sql
          .exec<{ cursor: string }>(
            `SELECT cursor FROM member_connections WHERE id = 'c-b'`,
          )
          .toArray()[0].cursor,
      ).toBe("");
    });
  });

  it("下载中途被撤销的成员媒体既不落盘也不派发", async () => {
    const ilink = fakeIlink();
    ilink.cdn.set("img-rev", encryptedPng());
    ilink.batches.set(CREDS_A.token, {
      ret: 0,
      get_updates_buf: "a-next",
      msgs: [mediaMessage("m-rev", CREDS_A.userId, [imageItem("img-rev")])],
    });
    setILinkFetchOverride(ilink.fetch);

    const delivered: AdmittedMessage[] = [];
    setMemberButlerOverride({
      initializeMember: async () => undefined,
      handleMessage: async (message) => {
        delivered.push(message);
      },
    });

    await runInDurableObject(hub(), async (instance, state) => {
      const seeded = await seedMembers(state);
      // The revoke lands while the CDN object is in flight.
      ilink.onDownload = () => {
        seeded.store.revoke(seeded.memberA.memberId);
      };
      const runtime = instance as unknown as MemberRuntime;

      await runtime.pollMemberWeChat({ connectionId: "c-a", generation: 1 });
      await settle();

      expect(delivered).toEqual([]);
      expect(
        state.storage.sql.exec(`SELECT * FROM attachment_owners`).toArray(),
      ).toEqual([]);
      expect(
        await artifactStore(env).get("inbox/wx:c-a:m-rev/image.png"),
      ).toBeNull();
    });
  });

  it("A 的媒体不把任何东西送进 B 的管家或主人", async () => {
    const ilink = fakeIlink();
    ilink.cdn.set("img-a", encryptedPng());
    ilink.batches.set(CREDS_A.token, {
      ret: 0,
      get_updates_buf: "a-next",
      msgs: [mediaMessage("m-a", CREDS_A.userId, [imageItem("img-a")], "看图")],
    });
    setILinkFetchOverride(ilink.fetch);

    const delivered: AdmittedMessage[] = [];
    setMemberButlerOverride({
      initializeMember: async () => undefined,
      handleMessage: async (message) => {
        delivered.push(message);
      },
    });

    await runInDurableObject(hub(), async (instance, state) => {
      const seeded = await seedMembers(state);
      const runtime = instance as unknown as MemberRuntime;

      await runtime.pollMemberWeChat({ connectionId: "c-a", generation: 1 });
      await settle();

      // Exactly one delivery, for A only.
      expect(delivered).toHaveLength(1);
      expect(delivered[0].actor?.memberId).toBe(seeded.memberA.memberId);
      expect(delivered[0].text).toBe("看图");
      const owners = state.storage.sql
        .exec<{ member_id: string }>(`SELECT member_id FROM attachment_owners`)
        .toArray();
      expect(owners.map((row) => row.member_id)).toEqual([
        seeded.memberA.memberId,
      ]);
      expect(
        state.storage.sql.exec(`SELECT * FROM outbound_queue`).toArray(),
      ).toEqual([]);
    });
  });
});

// The fixture's DO health: a ChannelDO created through the stub is the
// production class, so the member tables exist before the first assertion.
it("fixture boots a real ChannelDO", async () => {
  await runInDurableObject(channelStub("member-admission-boot"), (instance) => {
    expect(instance).toBeDefined();
  });
});
