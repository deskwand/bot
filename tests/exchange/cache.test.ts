import { describe, expect, it } from "vitest";
import { cacheKey, createSnapshotCache } from "../../src/exchange/cache";
import type { VenueSnapshot } from "../../src/exchange/types";

const snapshot = (account: string): VenueSnapshot => ({
  venue: "okx",
  account,
  fetchedAt: 0,
  buckets: [],
  positions: [],
  degraded: [],
});

describe("cacheKey", () => {
  it("ignores include order and keeps the account id", () => {
    expect(cacheKey("main", ["spot", "earn"])).toBe(
      cacheKey("main", ["earn", "spot"]),
    );
    expect(cacheKey("main", ["spot"])).not.toBe(cacheKey("other", ["spot"]));
  });

  it("changes when the include set changes", () => {
    expect(cacheKey("main", ["spot"])).not.toBe(cacheKey("main", ["spot", "earn"]));
  });
});

describe("createSnapshotCache", () => {
  it("returns a hit with its age inside the ttl", () => {
    let now = 1_000;
    const cache = createSnapshotCache(() => now, 60_000);
    const key = cacheKey("main", ["spot"]);
    cache.set(key, snapshot("main"));
    now = 13_000;
    expect(cache.get(key)?.ageMs).toBe(12_000);
    expect(cache.get(key)?.snapshot.account).toBe("main");
  });

  it("expires after the ttl", () => {
    let now = 1_000;
    const cache = createSnapshotCache(() => now, 60_000);
    const key = cacheKey("main", ["spot"]);
    cache.set(key, snapshot("main"));
    now = 61_001;
    expect(cache.get(key)).toBeUndefined();
  });

  it("never returns cross-account data", () => {
    const cache = createSnapshotCache(() => 0, 60_000);
    cache.set(cacheKey("a", ["spot"]), snapshot("a"));
    expect(cache.get(cacheKey("b", ["spot"]))).toBeUndefined();
  });
});
