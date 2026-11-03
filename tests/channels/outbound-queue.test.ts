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
