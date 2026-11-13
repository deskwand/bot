import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectModules,
  doBindings,
  renderTemplate,
  uniqueKeyFor,
  type DoBinding,
  type ModuleEntry,
} from "../scripts/build-container";

const repoRoot = resolve(import.meta.dirname, "..");

const MODULES: ModuleEntry[] = [{ name: "index.js", type: "esModule" }];

const DURABLE_OBJECTS: DoBinding[] = [
  { binding: "BUTLER", className: "ButlerDO" },
  { binding: "TASK", className: "TaskDO" },
  { binding: "BOT", className: "BotDO" },
  { binding: "BOT_CHAT", className: "BotChatDO" },
  { binding: "CHANNELS", className: "ChannelDO" },
  { binding: "MCP_AUTH", className: "McpAuthDO" },
  { binding: "LIFE", className: "LifeDO" },
  { binding: "WALLET", className: "WalletDO" },
  { binding: "EXCHANGE", className: "ExchangeDO" },
];

function readWrangler(): unknown {
  return JSON.parse(readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8"));
}

function render(overrides: {
  modules?: ModuleEntry[];
  durableObjects?: DoBinding[];
  version?: string;
} = {}): string {
  return renderTemplate({
    modules: overrides.modules ?? MODULES,
    compatibilityDate: "2026-11-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: overrides.durableObjects ?? DURABLE_OBJECTS,
    version: overrides.version ?? "dev",
  });
}

function withTempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "deskwand-container-config-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe("durable object bindings", () => {
  // This list may only grow. Renaming or reordering an existing entry would
  // make the data of already deployed containers unreadable.
  it("pins every Durable Object unique key", () => {
    expect(
      doBindings(readWrangler()).map((binding) => uniqueKeyFor(binding.className)),
    ).toEqual([
      "deskwand-ButlerDO",
      "deskwand-TaskDO",
      "deskwand-BotDO",
      "deskwand-BotChatDO",
      "deskwand-ChannelDO",
      "deskwand-McpAuthDO",
      "deskwand-LifeDO",
      "deskwand-WalletDO",
      "deskwand-ExchangeDO",
    ]);
  });

  it("binds every Durable Object from wrangler.jsonc", () => {
    const output = render({ durableObjects: doBindings(readWrangler()) });

    for (const { binding, className } of doBindings(readWrangler())) {
      expect(output).toContain(
        `(name = "${binding}", durableObjectNamespace = "${className}")`,
      );
      expect(output).toContain(
        `(className = "${className}", uniqueKey = "${uniqueKeyFor(className)}", enableSql = true)`,
      );
    }
  });
});

describe("renderTemplate", () => {
  it("declares neither AI nor ARTIFACTS", () => {
    expect(render()).not.toMatch(/name = "(AI|ARTIFACTS)"/);
  });

  it("provides the internal email module", () => {
    expect(render()).toContain(
      '(name = "cloudflare-internal:email", internal = true, esModule = embed "main/email-internal.js")',
    );
  });

  it("keeps the three placeholders", () => {
    const output = render();

    expect(output.split("@@LISTEN@@")).toHaveLength(2);
    expect(output.split("@@DATA_DIR@@")).toHaveLength(2);
    expect(output.split("# @@ENV_BINDINGS@@")).toHaveLength(2);
  });

  it("escapes the version into the metadata binding", () => {
    expect(render({ version: "1.2.3" })).toContain("container-1.2.3");
    expect(() => render({ version: '1"2' })).toThrow();
    expect(() => render({ version: "1\\2" })).toThrow();
  });
});

describe("collectModules", () => {
  it("types modules by extension, entry first", () => {
    const dir = withTempDir({
      "index.js": "",
      "b.wasm": "",
      "a.js": "",
      "index.js.map": "",
      "README.md": "",
    });
    try {
      expect(collectModules(dir)).toEqual([
        { name: "index.js", type: "esModule" },
        { name: "a.js", type: "esModule" },
        { name: "b.wasm", type: "wasm" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a bundle without index.js", () => {
    const dir = withTempDir({ "a.js": "" });
    try {
      expect(() => collectModules(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unexpected file", () => {
    const dir = withTempDir({ "index.js": "", "notes.txt": "" });
    try {
      expect(() => collectModules(dir)).toThrow(/notes\.txt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
