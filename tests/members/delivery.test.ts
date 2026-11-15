import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setILinkFetchOverride,
  setMemberButlerOverride,
  setPollTimingOverride,
} from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import { sha256Hex } from "../../src/channels/route-identity";
import { ConnectionStore } from "../../src/channels/wechat/connections";
import {
  LEGACY_INBOX_MIGRATION,
  ensureMigrationTable,
} from "../../src/members/artifact-access";
import { CredentialVault } from "../../src/members/credentials";
import { butlerName, type Principal } from "../../src/members/principal";
import { MemberStore, type VerifiedBinding } from "../../src/members/store";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const BASE_URL = "https://ilinkai.weixin.qq.com";
/** Unique per test: the singleton hub keeps members across the file. */
let seq = 0;
function creds(label: string) {
  seq += 1;
  return {
    token: `token-${label}-${seq}`,
    baseUrl: BASE_URL,
    accountId: `acct-${label}-${seq}`,
    userId: `user-${label}-${seq}`,
  };
}
let CREDS_A = creds("a");
let CREDS_B = creds("b");

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

type Sent = { token: string; text: string };

/** An iLink stand-in that records every outbound text per credential. */
function fakeIlink(handle: { sent: Sent[] }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = (headers.Authorization ?? "").replace(/^Bearer /, "");
    if (url.endsWith("/ilink/bot/sendmessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        msg?: { item_list?: { text_item?: { text?: string } }[] };
      };
      const text = body.msg?.item_list?.[0]?.text_item?.text ?? "";
      handle.sent.push({ token, text });
      return new Response(JSON.stringify({ ret: 0 }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ret: 0 }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

type Seeded = {
  store: MemberStore;
  actorA: Principal;
  actorB: Principal;
  connectionA: string;
  connectionB: string;
};

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

async function seedMembers(state: DurableObjectState): Promise<Seeded> {
  const sql = state.storage.sql;
  settleInbox(sql);
  const store = new MemberStore(sql, () => Date.now(), (fn) =>
    state.storage.transactionSync(fn),
  );
  const vault = new CredentialVault(state.storage);
  const connections = new ConnectionStore(sql, vault);
  const memberOf = async (
    label: string,
    creds: typeof CREDS_A,
    suffix: string,
  ) => {
    const raw = JSON.stringify(creds);
    const binding: VerifiedBinding = {
      connectionId: `c-${suffix}-${seq}`,
      credentialKey: `credential-${suffix}-${seq}`,
      accountId: creds.accountId,
      userId: creds.userId,
      credentialHash: await sha256Hex(raw),
    };
    await vault.put(binding.credentialKey, raw);
    const invite = store.createInvite(label);
    const member = store.completeInvite(invite.inviteId, binding);
    connections.setConversation(binding.connectionId, creds.userId);
    await connections.writeContext(binding.connectionId, 1, `ctx-${suffix}-${seq}`);
    const actor = store.principal(member.memberId);
    if (actor === null) throw new Error("fixture: principal missing");
    return { actor, connectionId: binding.connectionId };
  };
  const a = await memberOf("A", CREDS_A, "a");
  const b = await memberOf("B", CREDS_B, "b");
  return {
    store,
    actorA: a.actor,
    actorB: b.actor,
    connectionA: a.connectionId,
    connectionB: b.connectionId,
  };
}

/** The narrow ChannelDO surface these tests drive directly. */
type Hub = {
  handleMemberTextAction(
    event: {
      type: "message";
      channel: "wechat";
      chatId: string;
      userId: string;
      text: string;
      eventId: string;
    },
    eventId: string,
    routeKey: string,
    actor: Principal,
    ref: { memberId: string; connectionId: string; generation: number },
  ): Promise<boolean>;
  routeForMember(actor: Principal): Promise<{ routeKey: string }>;
};

/** A Task DO that reports its own state without a model run. */
async function seedMemberTask(
  taskId: string,
  actor: Principal,
  state: "running" | "completed",
): Promise<void> {
  const stub = env.TASK.get(env.TASK.idFromName(taskId));
  await runInDurableObject(stub, (instance, storage) => {
    void instance;
    storage.storage.sql.exec(
      `INSERT OR REPLACE INTO meta (key, value) VALUES
         ('task_id', ?), ('title', ?), ('state', ?), ('spec', ?)`,
      taskId,
      `任务 ${taskId}`,
      state,
      JSON.stringify({
        taskId,
        title: `任务 ${taskId}`,
        instructions: "noop",
        actor,
      }),
    );
  });
}

afterEach(() => {
  setILinkFetchOverride(null);
  setMemberButlerOverride(null);
  setPollTimingOverride(null);
  setModelOverride(null);
  restoreEnv();
  vi.restoreAllMocks();
});

beforeEach(() => {
  CREDS_A = creds("a");
  CREDS_B = creds("b");
});

describe("member text actions and delivery", () => {
  it("A 取消自己的 #1 不影响 B 的 #1，回复只发 A", async () => {
    const handle = { sent: [] as Sent[] };
    setILinkFetchOverride(fakeIlink(handle));
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    setModelOverride(scriptedModel([{ text: "ok" }]));

    // Member Butlers resolve their directory through the singleton hub, so the
    // fixture must seed that same object.
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
    const result = await runInDurableObject(stub, async (instance, storage) => {
      const { actorA, actorB, connectionA, connectionB } = await seedMembers(storage);
      const hub = instance as unknown as Hub;

      // Each member has its own #1 through its own Butler task index.
      await env.BUTLER.get(env.BUTLER.idFromName(butlerName(actorA.memberId)))
        .initializeMember(actorA);
      await env.BUTLER.get(env.BUTLER.idFromName(butlerName(actorB.memberId)))
        .initializeMember(actorB);
      const taskA = `${actorA.memberId}-t1`;
      const taskB = `${actorB.memberId}-t1`;
      for (const [id, actor] of [
        [taskA, actorA],
        [taskB, actorB],
      ] as const) {
        await runInDurableObject(
          env.BUTLER.get(env.BUTLER.idFromName(butlerName(actor.memberId))),
          (_butler, butlerState) => {
            void _butler;
            butlerState.storage.sql.exec(
              `INSERT OR REPLACE INTO tasks
                 (id, title, status, created_at, updated_at, chat_id, artifacts_json, last_seq, handle)
               VALUES (?, ?, 'running', 1, 1, NULL, '[]', 0, 1)`,
              id,
              `任务 ${id}`,
            );
          },
        );
        await seedMemberTask(id, actor, "running");
      }

      const routeA = await hub.routeForMember(actorA);
      const handled = await hub.handleMemberTextAction(
        {
          type: "message",
          channel: "wechat",
          chatId: CREDS_A.userId,
          userId: CREDS_A.userId,
          text: "取消 #1",
          eventId: "wx:c-a:cmd-1",
        },
        "wx:c-a:cmd-1",
        routeA.routeKey,
        actorA,
        { memberId: actorA.memberId, connectionId: connectionA, generation: 1 },
      );
      const stateOf = async (id: string): Promise<string> =>
        runInDurableObject(env.TASK.get(env.TASK.idFromName(id)), (_i, s) =>
          String(
            s.storage.sql
              .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'state'`)
              .toArray()[0]?.value,
          ),
        );
      return {
        handled,
        taskA: await stateOf(taskA),
        taskB: await stateOf(taskB),
        actorAMember: actorA.memberId,
        taskBId: taskB,
      };
    });

    expect(result.handled).toBe(true);
    expect(result.taskA).toBe("cancelled");
    expect(result.taskB).toBe("running");
    // The answer went out on A's own credential only.
    expect(handle.sent.length).toBeGreaterThan(0);
    expect(new Set(handle.sent.map((entry) => entry.token))).toEqual(
      new Set([CREDS_A.token]),
    );
  });

  it("B 用 A 的任务 id 发命令被拒，且不触碰 A 的任务", async () => {
    const handle = { sent: [] as Sent[] };
    setILinkFetchOverride(fakeIlink(handle));
    setEnv({ ACTIVE_CHANNEL: "wechat" });
    setModelOverride(scriptedModel([{ text: "ok" }]));

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
    const result = await runInDurableObject(stub, async (instance, storage) => {
      const { actorA, actorB, connectionA, connectionB } = await seedMembers(storage);
      const hub = instance as unknown as Hub;
      await env.BUTLER.get(env.BUTLER.idFromName(butlerName(actorB.memberId)))
        .initializeMember(actorB);
      const taskA = `${actorA.memberId}-t1`;
      await seedMemberTask(taskA, actorA, "running");

      const routeB = await hub.routeForMember(actorB);
      const handled = await hub.handleMemberTextAction(
        {
          type: "message",
          channel: "wechat",
          chatId: CREDS_B.userId,
          userId: CREDS_B.userId,
          text: `取消 ${taskA}`,
          eventId: "wx:c-b:cmd-1",
        },
        "wx:c-b:cmd-1",
        routeB.routeKey,
        actorB,
        { memberId: actorB.memberId, connectionId: connectionB, generation: 1 },
      );
      const stateA = await runInDurableObject(
        env.TASK.get(env.TASK.idFromName(taskA)),
        (_i, s) =>
          String(
            s.storage.sql
              .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'state'`)
              .toArray()[0]?.value,
          ),
      );
      return { handled, stateA };
    });

    expect(result.handled).toBe(true);
    expect(result.stateA).toBe("running");
    expect(handle.sent.map((entry) => entry.token)).toEqual([CREDS_B.token]);
  });
});
