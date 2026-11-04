import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATALOG_PATH,
  DESKTOP_CATALOG_PATH,
  TS_OUTPUT_PATH,
  buildCatalog,
  renderCatalogTs,
} from "../scripts/generate-model-catalog";

const EXCLUDED_PROVIDERS = [
  "amazon-bedrock",
  "google-vertex",
  "azure",
  "github-copilot",
  "openai-codex",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
];

const GENERIC_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

describe("generated model catalog", () => {
  it("matches the installed pi-ai providers", async () => {
    const catalog = await buildCatalog();
    expect(readFileSync(CATALOG_PATH, "utf8")).toBe(`${JSON.stringify(catalog, null, 2)}\n`);
    expect(readFileSync(TS_OUTPUT_PATH, "utf8")).toBe(renderCatalogTs(catalog));
    expect(readFileSync(DESKTOP_CATALOG_PATH)).toEqual(readFileSync(CATALOG_PATH));
  });

  it("lists Workers AI first as a keyless provider", async () => {
    const catalog = await buildCatalog();
    const first = catalog.providers[0]!;
    expect(first.id).toBe("workers-ai");
    expect(first.name).toBe("Cloudflare Workers AI（免费额度）");
    expect(first.keyless).toBe(true);
    const glm = first.models.find((m) => m.id === "@cf/zai-org/glm-5.3-flash");
    expect(glm?.api).toBe("openai-completions");
    expect(glm?.input).toEqual(["text", "image"]);
    expect(first.models.every((m) => m.api === "openai-completions")).toBe(true);
    expect(catalog.providers.slice(1).some((p) => p.keyless)).toBe(false);
  });

  it("does not import a factory for keyless providers", async () => {
    expect(renderCatalogTs(await buildCatalog())).not.toContain("workers-ai");
  });

  it("excludes non-api-key providers", async () => {
    const catalog = await buildCatalog();
    const ids = new Set(catalog.providers.map((provider) => provider.id));

    for (const id of EXCLUDED_PROVIDERS) {
      expect(ids.has(id), id).toBe(false);
    }
    expect(ids.has("typesafe"), "typesafe").toBe(false);
    for (const id of ["anthropic", "opencode", "opencode-go", "deepseek", "openrouter"]) {
      expect(ids.has(id), id).toBe(true);
    }

    const opencodeGo = catalog.providers.find((provider) => provider.id === "opencode-go");
    expect(opencodeGo).toBeDefined();
    const modelIds = opencodeGo!.models.map((model) => model.id);
    expect(modelIds).toContain("deepseek-v4.1-flash");
    expect(modelIds).not.toContain("gemini-4-argon-contributor");
  });

  it("only lists generic wire apis", async () => {
    const catalog = await buildCatalog();
    for (const provider of catalog.providers) {
      for (const model of provider.models) {
        expect(GENERIC_APIS.has(model.api), `${provider.id}/${model.id}: ${model.api}`).toBe(
          true,
        );
      }
    }
  });

  it("documents how to regenerate", () => {
    const source = readFileSync(TS_OUTPUT_PATH, "utf8");
    expect(source).toContain("node --experimental-strip-types scripts/generate-model-catalog.ts");
  });
});
