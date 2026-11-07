import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OutboundQueue } from "../../src/channels/outbound-queue";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function withQueue<T>(
  fn: (queue: OutboundQueue, sql: SqlStorage) => T | Promise<T>,
): Promise<T> {
  const hub = env.CHANNELS.get(
    env.CHANNELS.idFromName(`queue-${crypto.randomUUID()}`),
  );
  return runInDurableObject(hub, (_instance, state) =>
    fn(new OutboundQueue(state.storage.sql), state.storage.sql),
  );
}

describe("OutboundQueue", () => {
  it("keeps rows in insertion order with attempts and the last error", async () => {
    const rows = await withQueue((queue) => {
      const { id } = queue.enqueue({
        conversationId: "wx",
        text: "a",
        buttons: null,
      });
      queue.enqueue({ conversationId: "wx", text: "b", buttons: null });
      queue.markError(id, "api_error");
      queue.markError(id, "upstream_error");
      return queue.list();
    });

    expect(rows.map((row) => row.text)).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({ attempts: 2, lastError: "upstream_error" });
    expect(rows[1]).toMatchObject({ attempts: 0, lastError: null });
  });

  it("removes a delivered row", async () => {
    const remaining = await withQueue((queue) => {
      const { id } = queue.enqueue({
        conversationId: "wx",
        text: "a",
        buttons: null,
      });
      queue.remove(id);
      return queue.count();
    });
    expect(remaining).toBe(0);
  });

  it("drops the oldest row past the limit and reports how many it dropped", async () => {
    const { rows, dropped } = await withQueue((queue) => {
      let dropped = 0;
      for (let index = 0; index < 21; index++) {
        dropped += queue.enqueue({
          conversationId: "wx",
          text: `m${index}`,
          buttons: null,
        }).dropped;
      }
      return { rows: queue.list(), dropped };
    });

    expect(rows.map((row) => row.text)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => `m${index + 1}`),
    );
    expect(dropped).toBe(1);
  });

  it("drops the oldest normal row before any alert or critical", async () => {
    const { texts, dropped } = await withQueue((_queue, sql) => {
      const q = new OutboundQueue(sql, 3);
      q.enqueue({ conversationId: "c", text: "n1", buttons: null });
      q.enqueue({ conversationId: "c", text: "a1", buttons: null, priority: "alert" });
      q.enqueue({ conversationId: "c", text: "n2", buttons: null });
      const { dropped } = q.enqueue({
        conversationId: "c",
        text: "done",
        buttons: null,
        priority: "critical",
      });
      return { texts: q.list().map((m) => m.text), dropped };
    });

    expect(dropped).toBe(1);
    expect(texts).toEqual(["a1", "n2", "done"]);
  });

  it("drops an alert only when no normal row is left", async () => {
    const { texts, dropped } = await withQueue((_queue, sql) => {
      const q = new OutboundQueue(sql, 2);
      q.enqueue({ conversationId: "c", text: "a1", buttons: null, priority: "alert" });
      q.enqueue({ conversationId: "c", text: "a2", buttons: null, priority: "alert" });
      const { dropped } = q.enqueue({
        conversationId: "c",
        text: "c1",
        buttons: null,
        priority: "critical",
      });
      return { texts: q.list().map((m) => m.text), dropped };
    });

    expect(dropped).toBe(1);
    expect(texts).toEqual(["a2", "c1"]);
  });

  it("never drops critical rows, even past the limit", async () => {
    const texts = await withQueue((_queue, sql) => {
      const q = new OutboundQueue(sql, 2);
      for (const text of ["c1", "c2", "c3"]) {
        q.enqueue({ conversationId: "c", text, buttons: null, priority: "critical" });
      }
      return q.list().map((m) => m.text);
    });

    expect(texts).toEqual(["c1", "c2", "c3"]);
  });

  it("reads rows written before the priority column as normal", async () => {
    // A Butler has its own SQLite database and does not create this table.
    const hub = env.BUTLER.get(
      env.BUTLER.idFromName(`queue-${crypto.randomUUID()}`),
    );
    const { texts, dropped } = await runInDurableObject(
      hub,
      (_instance, state) => {
        // The table as an older release left it, without a priority column.
        state.storage.sql.exec(
          `CREATE TABLE outbound_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            text TEXT NOT NULL,
            buttons_json TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL
          )`,
        );
        state.storage.sql.exec(
          `INSERT INTO outbound_queue (conversation_id, text, created_at)
           VALUES ('wx', 'old', 0)`,
        );
        const q = new OutboundQueue(state.storage.sql, 1);
        const { dropped } = q.enqueue({
          conversationId: "wx",
          text: "c1",
          buttons: null,
          priority: "critical",
        });
        return { texts: q.list().map((m) => m.text), dropped };
      },
    );

    expect(dropped).toBe(1);
    expect(texts).toEqual(["c1"]);
  });

  it("round-trips buttons through JSON", async () => {
    const buttons = [[{ label: "取消", data: "cancel:t1" }]];
    const rows = await withQueue((queue) => {
      queue.enqueue({ conversationId: "wx", text: "a", buttons });
      return queue.list();
    });
    expect(rows[0]?.buttons).toEqual(buttons);
  });

  it("lists a row whose buttons JSON is corrupt instead of failing the queue", async () => {
    const rows = await withQueue((queue, sql) => {
      queue.enqueue({ conversationId: "wx", text: "a", buttons: null });
      sql.exec(`UPDATE outbound_queue SET buttons_json = 'not json'`);
      return queue.list();
    });

    expect(rows.map((row) => row.text)).toEqual(["a"]);
    expect(rows[0]?.buttons).toBeNull();
  });
});
