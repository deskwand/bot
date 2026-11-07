/**
 * Generates the shared model provider catalog from the installed pi-ai providers.
 *
 * Usage:
 *   node --experimental-strip-types scripts/generate-model-catalog.ts
 *
 * Sources:
 *   node_modules/@earendil-works/pi-ai/dist/providers/*.js
 * Outputs:
 *   contracts/model-catalog.json
 *   desktop/internal/modelcatalog/model-catalog.json (byte-for-byte copy)
 *   src/llm/catalog.generated.ts
 *
 * The outputs are checked by tests-node/model-catalog.test.ts so they cannot
 * drift from the installed pi-ai catalog.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";

export type CatalogModel = {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  input?: ("text" | "image")[];
  contextWindow: number;
};

export type CatalogProvider = {
  id: string;
  name: string;
  keyless?: true;
  models: CatalogModel[];
};

export type Catalog = {
  schemaVersion: 1;
  providers: CatalogProvider[];
};

type PiModel = {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  contextWindow: number;
};

type PiProvider = {
  id: string;
  name: string;
  getModels(): readonly PiModel[];
};

const PROVIDERS_DIR = resolve("node_modules/@earendil-works/pi-ai/dist/providers");

const EXCLUDED_PROVIDER_IDS = new Set([
  "amazon-bedrock",
  "google-vertex",
  "azure",
  "github-copilot",
  "openai-codex",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
]);

const GENERIC_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

export const CATALOG_PATH = resolve("contracts/model-catalog.json");
export const DESKTOP_CATALOG_PATH = resolve("desktop/internal/modelcatalog/model-catalog.json");
export const TS_OUTPUT_PATH = resolve("src/llm/catalog.generated.ts");

function workersAiProvider(): CatalogProvider {
  const models: CatalogModel[] = Object.values(CLOUDFLARE_WORKERS_AI_MODELS)
    .filter((model) => model.api === "openai-completions")
    .map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      input: model.input,
      contextWindow: model.contextWindow,
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  return {
    id: "workers-ai",
    name: "Cloudflare Workers AI（免费额度）",
    keyless: true,
    models,
  };
}

function listProviderModules(): string[] {
  return readdirSync(PROVIDERS_DIR)
    .filter(
      (file) =>
        file.endsWith(".js") &&
        !file.endsWith(".models.js") &&
        !file.endsWith(".lazy.js") &&
        file !== "all.js" &&
        file !== "faux.js",
    )
    .sort((left, right) => left.localeCompare(right, "en"));
}

function findProviderFactory(
  module: Record<string, unknown>,
): { name: string; factory: () => PiProvider } | undefined {
  const names = Object.keys(module).filter((name) => name.endsWith("Provider"));
  if (names.length !== 1) return undefined;
  const factory = module[names[0]!];
  if (typeof factory !== "function") return undefined;
  return { name: names[0]!, factory: factory as () => PiProvider };
}

/** Initialisms keep their uppercase spelling in pi-ai factory names. */
const UPPERCASE_WORDS = new Set(["ai"]);

/** Derives the exported factory name from a provider id, e.g. `opencode-go`. */
function providerFactoryName(providerId: string): string {
  const words = providerId.split("-");
  const camel = words
    .map((word, index) => {
      if (UPPERCASE_WORDS.has(word)) return word.toUpperCase();
      if (index === 0) return word;
      return word[0]!.toUpperCase() + word.slice(1);
    })
    .join("");
  return `${camel}Provider`;
}

/** Builds a deterministic provider catalog from the installed pi-ai modules. */
export async function buildCatalog(): Promise<Catalog> {
  const providers: CatalogProvider[] = [];

  for (const file of listProviderModules()) {
    const module = (await import(
      pathToFileURL(join(PROVIDERS_DIR, file)).href
    )) as Record<string, unknown>;
    const discovered = findProviderFactory(module);
    if (!discovered) continue;

    const provider = discovered.factory();
    if (EXCLUDED_PROVIDER_IDS.has(provider.id)) continue;
    if (discovered.name !== providerFactoryName(provider.id)) {
      throw new Error(
        `${file} exports ${discovered.name}, expected ${providerFactoryName(provider.id)}`,
      );
    }

    const models: CatalogModel[] = provider
      .getModels()
      .filter((model) => GENERIC_APIS.has(model.api))
      .map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        contextWindow: model.contextWindow,
      }))
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    if (models.length === 0) continue;

    providers.push({ id: provider.id, name: provider.name, models });
  }

  providers.sort((left, right) => left.id.localeCompare(right.id, "en"));
  providers.unshift(workersAiProvider());
  return { schemaVersion: 1, providers };
}

/** Renders the Worker-facing TypeScript module. Keep one provider per line. */
export function renderCatalogTs(catalog: Catalog): string {
  const lines = [
    "// Code generated by scripts/generate-model-catalog.ts from the installed",
    "// @earendil-works/pi-ai provider modules.",
    "// Regenerate with:",
    "//   node --experimental-strip-types scripts/generate-model-catalog.ts",
    "// Do not edit by hand.",
    'import type { Provider } from "@earendil-works/pi-ai/models";',
  ];
  for (const provider of catalog.providers) {
    if (provider.keyless) continue;
    lines.push(
      `import { ${providerFactoryName(provider.id)} } from "@earendil-works/pi-ai/providers/${provider.id}";`,
    );
  }
  lines.push(
    "",
    "export const BUILTIN_PROVIDERS: readonly { id: string; create: () => Provider }[] = [",
  );
  for (const provider of catalog.providers) {
    if (provider.keyless) continue;
    lines.push(
      `  { id: ${JSON.stringify(provider.id)}, create: () => ${providerFactoryName(provider.id)}() },`,
    );
  }
  lines.push("];", "");
  return lines.join("\n");
}

async function writeCatalog(): Promise<void> {
  const catalog = await buildCatalog();
  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  const typescript = renderCatalogTs(catalog);

  mkdirSync(dirname(CATALOG_PATH), { recursive: true });
  writeFileSync(CATALOG_PATH, json);
  mkdirSync(dirname(DESKTOP_CATALOG_PATH), { recursive: true });
  writeFileSync(DESKTOP_CATALOG_PATH, json);
  mkdirSync(dirname(TS_OUTPUT_PATH), { recursive: true });
  writeFileSync(TS_OUTPUT_PATH, typescript);

  console.log(`Wrote ${catalog.providers.length} providers to ${CATALOG_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeCatalog();
}
