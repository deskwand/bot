import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { memberPollDeferDelayMs } from "../../src/channels/channel-do";
import { OutboundQueue } from "../../src/channels/outbound-queue";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function channel(name: string) {
  return env.CHANNELS.get(env.CHANNELS.idFromName(`${name}-${crypto.randomUUID()}`));
}

type Private = {
  deferMemberPoll(
    ref: { connectionId: string; generation: number },
    reason: string,
  ): Promise<void>;
  deferMemberFlush(
    queue: OutboundQueue,
    connectionId: string,
    generation: number,
    reason: string,
  ): Promise<void>;
};

describe("member poll backoff", () => {
  it("starts at one second and caps at ten", () => {
    const delays = [1, 2, 3, 4, 5, 9].map((n) => memberPollDeferDelayMs(n));
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });

  it("persists the attempt count across a deferral", async () => {
    const hub = channel("poll-defer");
    const counts = await runInDurableObject(hub, async (instance, state) => {
      const api = instance as unknown as Private;
      const ref = { connectionId: "c-1", generation: 1 };
      await api.deferMemberPoll(ref, "maintenance");
      await api.deferMemberPoll(ref, "maintenance");
      const afterDefer = await state.storage.get<number>("poll:defer:c-1:1");
      return afterDefer;
    });
    // A restart must not reset the backoff to one second.
    expect(counts).toBe(2);
  });
});

describe("member send budget", () => {
  function seedConnection(sql: SqlStorage): void {
    sql.exec(
      `INSERT INTO member_connections
         (id, member_id, account_id, user_id, credential_key, credentials_hash,
          generation, status, cursor, conversation_id, poll_status)
       VALUES ('c-send', 'm-send', 'acct', 'user', 'cred', 'hash', 1, 'active', '', '', 'polling')`,
    );
  }

  it("stops retrying and marks the channel after the budget is spent", async () => {
    const hub = channel("send-budget");
    const outcome = await runInDurableObject(hub, async (instance, state) => {
      seedConnection(state.storage.sql);
      const queue = new OutboundQueue(state.storage.sql, {
        connectionId: "c-send",
        generation: 1,
      });
      queue.enqueue({ conversationId: "user", text: "reply", buttons: null });
      const api = instance as unknown as Private;
      for (let attempt = 0; attempt < 7; attempt += 1) {
        await api.deferMemberFlush(queue, "c-send", 1, "send failed");
      }
      const row = state.storage.sql
        .exec<{ poll_status: string }>(
          `SELECT poll_status FROM member_connections WHERE id = 'c-send'`,
        )
        .toArray()[0];
      return {
        pollStatus: row?.poll_status,
        error: await state.storage.get<string>("channel:error:c-send"),
        rows: queue.listCurrent().length,
      };
    });
    // A channel that cannot deliver waits for an operator instead of spinning.
    expect(outcome.pollStatus).toBe("needs_reset");
    expect(outcome.error).toBe("SEND_EXHAUSTED");
    expect(outcome.rows).toBe(1);
  });
});

describe("drain wiring", () => {
  it("defers when the channel has no address yet", async () => {
    const hub = channel("drain-wiring");
    const deferred = await runInDurableObject(hub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO member_connections
           (id, member_id, account_id, user_id, credential_key, credentials_hash,
            generation, status, cursor, conversation_id, poll_status)
         VALUES ('c-drain', 'm-drain', 'acct2', 'user2', 'cred', 'hash', 1,
                 'active', '', '', 'polling')`,
      );
      const queue = new OutboundQueue(state.storage.sql, {
        connectionId: "c-drain",
        generation: 1,
      });
      queue.enqueue({ conversationId: "", text: "reply", buttons: null });
      await (
        instance as unknown as {
          drainMemberOutbound(connectionId: string, generation: number): Promise<void>;
        }
      ).drainMemberOutbound("c-drain", 1);
      return state.storage.get<number>("flush:defer:c-drain:1");
    });
    // The drain itself must defer: calling the helper directly proved nothing.
    expect(deferred).toBe(1);
  });
});
