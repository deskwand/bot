import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultLevelFrom as desktop } from "../desktop/frontend/src/features/models/thinking-level";
import { defaultLevelFrom as worker } from "../src/llm/thinking-level";

type Catalog = { providers: { models: { thinkingLevels?: string[] }[] }[] };

describe("the desktop mirrors the worker's default thinking level", () => {
  // The two live in different packages and cannot share code; this walks the
  // catalog so a drift in either copy fails here instead of in production.
  it("agrees on every level set the catalog ships", () => {
    const catalog = JSON.parse(
      readFileSync(resolve("contracts/model-catalog.json"), "utf8"),
    ) as Catalog;
    const sets = new Set(
      catalog.providers.flatMap((provider) =>
        provider.models.map((model) => (model.thinkingLevels ?? []).join(",")),
      ),
    );

    expect(sets.size).toBeGreaterThan(1);
    for (const key of sets) {
      const levels = key === "" ? [] : key.split(",");
      expect(desktop(levels), key).toBe(worker(levels));
    }
  });
});
