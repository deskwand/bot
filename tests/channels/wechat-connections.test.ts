import { describe, expect, it } from "vitest";
import { MemberStore } from "../../src/members/store";
import type { VerifiedBinding } from "../../src/members/store";
import {
  LEGACY_INBOX_MIGRATION,
  ensureMigrationTable,
} from "../../src/members/artifact-access";
import {
  ConnectionStore,
  contextKey,
} from "../../src/channels/wechat/connections";
import { MEMBER_NOW, memberBinding, withMemberState } from "../helpers/members";

type Vault = ReturnType<typeof fakeVault>;

/** The private KV namespace, faked: the store must never put the token in SQL. */
function fakeVault() {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

const bindingB: VerifiedBinding = {
  connectionId: "c-b",
  credentialKey: "credential-b-op1",
  accountId: "wx-b",
  userId: "user-b",
  credentialHash: "fake-b-hash",
};

/**
 * A fixture DO is booted by the production class, so its pre-members tables may
 * already exist and leave the inbox question open. Settle it the way a
 * completed boot does, otherwise activation stays gated.
 */
function settleInbox(sql: SqlStorage): void {
  ensureMigrationTable(sql);
  sql.exec(
    `INSERT INTO member_migrations (name, cursor, done, updated_at)
     VALUES (?, NULL, 1, ?)
     ON CONFLICT(name) DO UPDATE SET done = 1, updated_at = excluded.updated_at`,
    LEGACY_INBOX_MIGRATION,
    MEMBER_NOW,
  );
}

type Fixture = {
  store: MemberStore;
  connections: ConnectionStore;
  sql: SqlStorage;
  vault: Vault;
};

/** Real SQL fixture: the directory and the per-connection rows share storage. */
function withConnections<T>(
  run: (fixture: Fixture) => T | Promise<T>,
): Promise<T> {
  return withMemberState((state) => {
    const sql = state.storage.sql;
    settleInbox(sql);
    const store = new MemberStore(
      sql,
      () => MEMBER_NOW,
      (fn) => state.storage.transactionSync(fn),
    );
    const vault = fakeVault();
    return run({
      store,
      connections: new ConnectionStore(sql, vault),
      sql,
      vault,
    });
  });
}

function activate(
  store: MemberStore,
  label: string,
  binding: VerifiedBinding,
) {
  const invite = store.createInvite(label);
  return store.completeInvite(invite.inviteId, binding);
}

function activateTwo(store: MemberStore) {
  return {
    a: activate(store, "A", memberBinding),
    b: activate(store, "B", bindingB),
  };
}

describe("ConnectionStore", () => {
  it("reads an activated connection with its runtime columns defaulted", async () => {
    const { view, member } = await withConnections(({ store, connections }) => {
      const member = activate(store, "A", memberBinding);
      return { view: connections.read(memberBinding.connectionId), member };
    });

    expect(view).toEqual({
      connectionId: "c-a",
      memberId: member.memberId,
      accountId: "wx-a",
      userId: "user-a",
      generation: 1,
      status: "active",
      conversationId: "",
      pollStatus: "idle",
      lastPollAt: null,
      expiryNotified: false,
    });
  });

  it("updates only the whitelisted columns", async () => {
    const view = await withConnections(({ store, connections }) => {
      activate(store, "A", memberBinding);
      const written = connections.update("c-a", {
        conversationId: "wx-chat-a",
        pollStatus: "polling",
        lastPollAt: MEMBER_NOW,
        expiryNotified: true,
      });
      return { written, view: connections.read("c-a") };
    });

    expect(view.written).toBe(true);
    expect(view.view).toMatchObject({
      conversationId: "wx-chat-a",
      pollStatus: "polling",
      lastPollAt: MEMBER_NOW,
      expiryNotified: true,
    });
  });

  it("refuses an unknown status and a no-op patch", async () => {
    const { emptyPatch, unknownStatus, unchanged } = await withConnections(
      ({ store, connections }) => {
        activate(store, "A", memberBinding);
        return {
          emptyPatch: connections.update("c-a", {}),
          unknownStatus: () =>
            connections.update("c-a", { pollStatus: "running" as never }),
          unchanged: connections.read("c-a"),
        };
      },
    );

    expect(emptyPatch).toBe(false);
    expect(unknownStatus).toThrow();
    expect(unchanged?.pollStatus).toBe("idle");
  });

  it("lists only active connections and writes nothing to a retired one", async () => {
    const { active, refreshed, retiredUpdate } = await withConnections(
      ({ store, connections }) => {
        const { a, b } = activateTwo(store);
        const before = connections.listActive();
        store.revoke(a.memberId);
        return {
          active: before,
          refreshed: connections.listActive(),
          retiredUpdate: connections.update("c-a", { pollStatus: "polling" }),
        };
      },
    );

    expect(active.map((row) => row.connectionId).sort()).toEqual(["c-a", "c-b"]);
    expect(refreshed.map((row) => row.connectionId)).toEqual(["c-b"]);
    expect(retiredUpdate).toBe(false);
  });

  it("keeps the context token in the vault under the connection and generation", async () => {
    const { token, key, stored, sqlDump } = await withConnections(
      async ({ store, connections, sql, vault }) => {
        activate(store, "A", memberBinding);
        const written = await connections.writeContext(
          "c-a",
          1,
          "context-token-a",
        );
        return {
          token: await connections.readContext("c-a", 1),
          key: contextKey("c-a", 1),
          written,
          stored: [...vault.values.entries()],
          sqlDump: JSON.stringify(
            sql.exec(`SELECT * FROM member_connections`).toArray(),
          ),
        };
      },
    );

    expect(key).toBe("connection:c-a:1:context");
    expect(token).toBe("context-token-a");
    expect(stored).toEqual([["connection:c-a:1:context", "context-token-a"]]);
    expect(sqlDump).not.toContain("context-token-a");
  });

  it("invalidates reads and writes of a replaced generation", async () => {
    const result = await withConnections(async ({ store, connections }) => {
      const member = activate(store, "A", memberBinding);
      await connections.writeContext("c-a", 1, "context-op1");
      const invite = store.createInvite("A", {
        kind: "rebind",
        targetMemberId: member.memberId,
      });
      store.completeInvite(invite.inviteId, {
        ...memberBinding,
        connectionId: "c-a2",
        credentialKey: "credential-a-op2",
        credentialHash: "fake-a-hash-2",
      });
      return {
        current: connections.read("c-a2"),
        oldRow: connections.read("c-a"),
        staleRead: await connections.readContext("c-a2", 1),
        staleWrite: await connections.writeContext("c-a2", 1, "stale"),
        guardedUpdate: connections.update("c-a2", { pollStatus: "polling" }, 1),
        currentUpdate: connections.update("c-a2", { pollStatus: "polling" }, 2),
        currentRead: await connections.readContext("c-a2", 2),
      };
    });

    expect(result.current).toMatchObject({ generation: 2, pollStatus: "idle" });
    expect(result.oldRow).toBeNull();
    expect(result.staleRead).toBeNull();
    expect(result.staleWrite).toBe(false);
    expect(result.guardedUpdate).toBe(false);
    expect(result.currentUpdate).toBe(true);
    expect(result.currentRead).toBeNull();
  });
});

describe("MemberStore connection metadata", () => {
  it("returns typed connection metadata with a fixed field set", async () => {
    const { one, all } = await withConnections(({ store }) => {
      const { a } = activateTwo(store);
      return { one: store.getConnection(a.memberId), all: store.listConnections() };
    });

    expect(one).toEqual({
      connectionId: "c-a",
      memberId: expect.stringMatching(/^m[0-9a-f]+$/),
      accountId: "wx-a",
      userId: "user-a",
      credentialHash: "fake-a-hash",
      generation: 1,
      status: "active",
      cursor: "",
    });
    expect(Object.keys(one ?? {}).sort()).toEqual([
      "accountId",
      "connectionId",
      "credentialHash",
      "cursor",
      "generation",
      "memberId",
      "status",
      "userId",
    ]);
    expect(all.map((row) => row.connectionId).sort()).toEqual(["c-a", "c-b"]);
  });

  it("hides retired connections and missing members", async () => {
    const { retired, unknown } = await withConnections(({ store }) => {
      const { a } = activateTwo(store);
      store.revoke(a.memberId);
      return {
        retired: {
          one: store.getConnection(a.memberId),
          all: store.listConnections(),
        },
        unknown: store.getConnection("m-does-not-exist"),
      };
    });

    expect(retired.one).toBeNull();
    expect(retired.all.map((row) => row.connectionId)).toEqual(["c-b"]);
    expect(unknown).toBeNull();
  });
});
