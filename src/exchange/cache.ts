import type { Include, VenueSnapshot } from "./types";

const TTL_MS = 60_000;

/** The include set changes which endpoints are called, so it belongs in the key. */
export function cacheKey(accountId: string, include: readonly Include[]): string {
  return `${accountId}:${[...include].sort().join(",")}`;
}

export type SnapshotCache = {
  get(key: string): { snapshot: VenueSnapshot; ageMs: number } | undefined;
  set(key: string, snapshot: VenueSnapshot): void;
  clear(): void;
};

export function createSnapshotCache(
  now: () => number = Date.now,
  ttlMs: number = TTL_MS,
): SnapshotCache {
  const entries = new Map<string, { at: number; snapshot: VenueSnapshot }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      const ageMs = now() - entry.at;
      if (ageMs >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return { snapshot: entry.snapshot, ageMs };
    },
    set(key, snapshot) {
      entries.set(key, { at: now(), snapshot });
    },
    clear() {
      entries.clear();
    },
  };
}
