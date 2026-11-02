import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BackupRpc, KV_TABLE } from "../../src/admin/backup-rpc";
import { PAGE_BYTES, type DumpRow } from "../../src/admin/sql-dump";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function harness(name: string) {
  return env.TEST_HARNESS.get(env.TEST_HARNESS.idFromName(name));
}

type KvDump = { rows: DumpRow[]; pageSizes: number[] };

async function dumpKv(state: DurableObjectState): Promise<KvDump> {
  const rpc = new BackupRpc(state, null);
  const rows: DumpRow[] = [];
  const pageSizes: number[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i += 1) {
    const page = await rpc.backupPage(KV_TABLE, cursor);
    if (page.rows.length > 128) {
      throw new Error(`KV page returned ${page.rows.length} rows`);
    }
    rows.push(...page.rows);
    pageSizes.push(page.rows.length);
    cursor = page.next;
    if (cursor === null) return { rows, pageSizes };
  }
  throw new Error("too many KV pages");
}

describe("BackupRpc KV pages", () => {
  it("round-trips more than 128 keys through paging and chunked puts", async () => {
    const source = harness("backup-kv-many");
    const dumped = await runInDurableObject(
      source,
      async (_instance, state) => {
        const entries: Record<string, unknown> = {};
        for (let i = 0; i < 300; i += 1) {
          entries[`k${String(i).padStart(3, "0")}`] = { n: i };
        }
        await state.storage.put(entries);
        return dumpKv(state);
      },
    );

    expect(dumped.rows).toHaveLength(300);
    expect(dumped.pageSizes.length).toBeGreaterThan(1);

    const target = harness("backup-kv-many-target");
    const restored = await runInDurableObject(
      target,
      async (_instance, state) => {
        const rpc = new BackupRpc(state, null);
        await rpc.restoreBegin({ tables: [KV_TABLE], indexes: [] });
        await rpc.restorePage(KV_TABLE, dumped.rows);
        return [...(await state.storage.list()).entries()];
      },
    );

    expect(restored).toHaveLength(300);
    expect(restored[0]).toEqual(["k000", { n: 0 }]);
    expect(restored[299]).toEqual(["k299", { n: 299 }]);
  });

  it("bounds KV pages by bytes as well as key count", async () => {
    const source = harness("backup-kv-bytes");
    const dumped = await runInDurableObject(
      source,
      async (_instance, state) => {
        const body = "x".repeat(400 * 1024);
        await state.storage.put({ a: body, b: body, c: body });
        return dumpKv(state);
      },
    );

    expect(dumped.rows).toHaveLength(3);
    expect(dumped.pageSizes.length).toBeGreaterThan(1);
    expect(dumped.pageSizes[0]).toBeLessThan(3);
    expect(
      dumped.rows.some((row) => JSON.stringify(row).length > PAGE_BYTES / 4),
    ).toBe(true);
  });
});
