import { env, runInDurableObject } from "cloudflare:test";
import {
  MEMBERS_AWARE_TABLES,
  bootstrapMemberSchema,
  ensureMigrationTable,
} from "../../src/members/artifact-access";
import { MemberStore } from "../../src/members/store";
import type { VerifiedBinding } from "../../src/members/store";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** Fixed clock for every directory fixture. */
export const MEMBER_NOW = 1_700_000_000_000;

export const ownerBinding: VerifiedBinding = {
  connectionId: "c-owner",
  credentialKey: "credential-owner-op1",
  accountId: "wx-owner",
  userId: "user-owner",
  credentialHash: "fake-owner-hash",
};

export const memberBinding: VerifiedBinding = {
  connectionId: "c-a",
  credentialKey: "credential-a-op1",
  accountId: "wx-a",
  userId: "user-a",
  credentialHash: "fake-a-hash",
};

function memberStub(name: string) {
  return env.CHANNELS.get(
    env.CHANNELS.idFromName(`${name}-${crypto.randomUUID()}`),
  );
}

/** Real SQL fixture: the directory is always built on a live DO storage. */
export function withMemberStoreSql<T>(
  run: (store: MemberStore, sql: SqlStorage) => T | Promise<T>,
  now: () => number = () => MEMBER_NOW,
): Promise<T> {
  return runInDurableObject(memberStub("member-sql-test"), (_instance, state) =>
    run(
      new MemberStore(state.storage.sql, now, (fn) =>
        state.storage.transactionSync(fn),
      ),
      state.storage.sql,
    ),
  );
}

/**
 * Same real store, but every transaction runs `fault` after the operation
 * body and before commit: a thrown fault must roll the whole activation back.
 */
export function withFaultingMemberStore<T>(
  fault: (sql: SqlStorage) => void,
  run: (store: MemberStore, sql: SqlStorage) => T | Promise<T>,
  now: () => number = () => MEMBER_NOW,
): Promise<T> {
  return runInDurableObject(memberStub("member-fault-test"), (_instance, state) =>
    run(
      new MemberStore(state.storage.sql, now, (fn) =>
        state.storage.transactionSync(() => {
          const result = fn();
          fault(state.storage.sql);
          return result;
        }),
      ),
      state.storage.sql,
    ),
  );
}

/**
 * A pre-members database: the legacy channel tables exist at first boot.
 *
 * Fixture DOs are constructed by their production class, whose constructor
 * already created the members-aware tables and recorded this database as
 * members-aware. Faithfully simulating an upgraded store means rewinding that
 * first-boot state (test fixture only: drop the directory tables, clear
 * `member_migrations`, which also clears any migration marker) and then
 * letting the bootstrap observe just the legacy tables, exactly as it would on
 * a real deployment that had `wechat_state` before members existed. The
 * directory is rebuilt afterwards over the recorded provenance, the same way
 * the production constructor does it.
 */
export function seedLegacySchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS wechat_state (
      credentials_hash TEXT,
      cursor TEXT,
      status TEXT,
      last_poll_at INTEGER,
      expiry_notified INTEGER
    )`,
  );
  ensureMigrationTable(sql);
  sql.exec(`DELETE FROM member_migrations`);
  for (const table of MEMBERS_AWARE_TABLES) {
    sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  bootstrapMemberSchema(sql, () => MEMBER_NOW);
  new MemberStore(sql, () => MEMBER_NOW);
}

export function withMemberStore<T>(
  run: (store: MemberStore) => T | Promise<T>,
  now: () => number = () => MEMBER_NOW,
): Promise<T> {
  return withMemberStoreSql((store) => run(store), now);
}

/** Raw DO state, for modules that need sql and the private KV namespace. */
export function withMemberState<T>(
  run: (state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(memberStub("member-state-test"), (_i, state) =>
    run(state),
  );
}
