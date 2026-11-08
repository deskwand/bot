import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { describe, expect, it } from "vitest";
import { defaultLevelFrom as desktop } from "../desktop/frontend/src/features/models/thinking-level";
import { defaultLevelFrom as worker } from "../src/llm/thinking-level";

type ShippedModel = { id: string; thinkingLevels?: string[] };
type Catalog = { providers: { id: string; models: ShippedModel[] }[] };

/** The api families the catalog generator ships; it drops the rest. */
const GENERIC_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

function readCatalog(): Catalog {
  return JSON.parse(
    readFileSync(resolve("contracts/model-catalog.json"), "utf8"),
  ) as Catalog;
}

describe("the desktop mirrors the worker's default thinking level", () => {
  // The two live in different packages and cannot share code; this walks the
  // catalog so a drift in either copy fails here instead of in production.
  it("agrees on every level set the catalog ships", () => {
    const sets = new Set(
      readCatalog()
        .providers.flatMap((provider) => provider.models)
        .map((model) => (model.thinkingLevels ?? []).join(",")),
    );

    expect(sets.size).toBeGreaterThan(1);
    for (const key of sets) {
      const levels = key === "" ? [] : key.split(",");
      expect(desktop(levels), key).toBe(worker(levels));
    }
  });

  // The worker reads pi's model objects while the desktop reads the generated
  // catalog. If those ever disagree the picker would show one default and the
  // session would run another, so check the catalog against pi directly.
  it("ships the level list pi reports for the same model", () => {
    const shipped = new Map(
      readCatalog().providers.map((provider) => [
        provider.id,
        new Map(provider.models.map((model) => [model.id, model.thinkingLevels])),
      ]),
    );

    const checked: string[] = [];
    const compare = (providerId: string, model: { id: string; api: string }) => {
      if (!GENERIC_APIS.has(model.api)) return;
      const levels = getSupportedThinkingLevels(model as never);
      expect(shipped.get(providerId)?.get(model.id), `${providerId}/${model.id}`).toEqual(
        levels.length > 1 ? levels : undefined,
      );
      checked.push(`${providerId}/${model.id}`);
    };

    for (const factory of [
      anthropicProvider,
      deepseekProvider,
      opencodeGoProvider,
      zaiProvider,
    ]) {
      const provider = factory();
      for (const model of provider.getModels()) compare(provider.id, model);
    }
    for (const model of Object.values(CLOUDFLARE_WORKERS_AI_MODELS)) {
      compare("workers-ai", model);
    }

    // Guards against a filter that quietly compares nothing.
    expect(checked.length).toBeGreaterThan(50);
  });
});
