import { env, runInDurableObject } from "cloudflare:test";

/** Empties the wallet ledger, its KV state and the in-memory value cache. */
export async function resetWallet(): Promise<void> {
  await runInDurableObject(
    env.WALLET.get(env.WALLET.idFromName("global")),
    async (instance, state) => {
      const tables = new Set(
        state.storage.sql
          .exec<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
          )
          .toArray()
          .map((row) => row.name),
      );
      if (tables.has("remittances")) {
        state.storage.sql.exec(`DELETE FROM remittances`);
      }
      const keys = await state.storage.list();
      for (const key of keys.keys()) {
        await state.storage.delete(key);
      }
      await state.storage.deleteAlarm();
      (instance as unknown as { cachedValue?: unknown }).cachedValue =
        undefined;
    },
  );
}
