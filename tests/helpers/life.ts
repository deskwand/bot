import { env, runInDurableObject } from "cloudflare:test";

const LEDGER_TABLES = ["spend", "credit", "totals", "spend_hourly"] as const;

/** Empties the shared ledger, its rollups and the last notified tier. */
export async function resetLife(): Promise<void> {
  await runInDurableObject(
    env.LIFE.get(env.LIFE.idFromName("global")),
    async (instance, state) => {
      const tables = new Set(
        state.storage.sql
          .exec<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
          )
          .toArray()
          .map((row) => row.name),
      );
      for (const table of LEDGER_TABLES) {
        if (tables.has(table)) {
          state.storage.sql.exec(`DELETE FROM ${table}`);
        }
      }
      await state.storage.delete("notified_tier");
      (instance as unknown as { cachedVitals?: unknown }).cachedVitals =
        undefined;
    },
  );
}
