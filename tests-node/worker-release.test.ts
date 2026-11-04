import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_COMPRESSED_BYTES,
  MAX_FILE_SANITY_BYTES,
  MAX_TOTAL_SANITY_BYTES,
  assertSafeRelativePath,
  buildManifestFromFiles,
  canonicalJson,
  collectModuleFiles,
  compareReleaseVersions,
  compressedSizeOf,
  generateModules,
  pathComparisonKey,
  readTemplateFile,
  sha256Hex,
  validateFileEntries,
  type ReleaseManifest,
  type ReleaseTemplate,
} from "../scripts/build-worker-release";
import {
  loadSigningKey,
  signManifest,
  verifyManifestSignature,
} from "../scripts/sign-worker-release";

const repoRoot = resolve(import.meta.dirname, "..");
const templatePath = join(repoRoot, "contracts", "release-template.json");
const schemaPath = join(repoRoot, "contracts", "deployment-config.schema.json");
const fixtureDir = join(repoRoot, "contracts", "fixtures", "release");

function readTemplate(): ReleaseTemplate {
  return readTemplateFile(templatePath);
}

function readSchema(): unknown {
  return JSON.parse(readFileSync(schemaPath, "utf8"));
}

function sampleFiles(): Map<string, Uint8Array> {
  return new Map([
    ["index.js", Buffer.from('export default { fetch() { return new Response("ok"); } };\n')],
    ["chunks/extra.js", Buffer.from("export const extra = 1;\n")],
  ]);
}

function build(overrides: {
  version?: string;
  keyId?: string;
  files?: Map<string, Uint8Array>;
  template?: ReleaseTemplate;
  entrypoint?: string;
  minFromVersion?: string;
} = {}) {
  return buildManifestFromFiles({
    template: overrides.template ?? readTemplate(),
    configSchema: readSchema(),
    version: overrides.version ?? "1.0.0",
    keyId: overrides.keyId ?? "deskwand-release-test",
    files: overrides.files ?? sampleFiles(),
    entrypoint: overrides.entrypoint,
    minFromVersion: overrides.minFromVersion ?? "1.0.0",
  });
}

describe("Worker release manifest", () => {
  it("is deterministic and canonical for the same module set", () => {
    const first = build();
    const second = build();

    expect(first.manifestBytes.equals(second.manifestBytes)).toBe(true);
    expect(first.manifestBytes.equals(Buffer.from(canonicalJson(first.manifest)))).toBe(true);
    expect(first.manifestBytes.toString("utf8")).not.toContain("\n");
    expect(first.manifestBytes.toString("utf8")).not.toContain(": ");
    expect(first.manifestBytes.toString("utf8")).not.toContain(", ");
    expect(first.manifest.files.map((file) => file.path)).toEqual([
      "chunks/extra.js",
      "index.js",
    ]);
    expect(first.manifest.compressedSize).toBe(compressedSizeOf(first.files));
    expect(first.compressedSize).toBe(first.manifest.compressedSize);
  });

  it("sorts ASCII module paths deterministically", () => {
    const files = new Map([
      ["z.js", Buffer.from("export const z = true;\n")],
      ["a/b.js", Buffer.from("export const b = true;\n")],
      ["index.js", Buffer.from("export default {};\n")],
    ]);
    const { manifest } = build({ files });
    expect(manifest.files.map((file) => file.path)).toEqual([
      "a/b.js",
      "index.js",
      "z.js",
    ]);
  });

  it("carries the full migration history, bindings and install parameters", () => {
    const { manifest } = build();

    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.configSchemaVersion).toBe(1);
    expect(manifest.migrations.map((migration) => migration.tag)).toEqual(["v1", "v2", "v3", "v4"]);
    expect(manifest.resourceTemplate.durableObjects).toEqual([
      { name: "BUTLER", className: "ButlerDO" },
      { name: "TASK", className: "TaskDO" },
      { name: "BOT", className: "BotDO" },
      { name: "CHANNELS", className: "ChannelDO" },
      { name: "MCP_AUTH", className: "McpAuthDO" },
    ]);
    expect(manifest.resourceTemplate.r2Buckets).toEqual([
      { name: "ARTIFACTS", parameterKey: "r2BucketName" },
    ]);
    expect(manifest.resourceTemplate.aiBindings).toEqual([{ name: "AI" }]);
    expect(manifest.resourceTemplate.versionMetadataBinding.name).toBe("CF_VERSION_METADATA");
    expect(manifest.resourceTemplate.configBinding).toEqual({
      name: "DESKWAND_CONFIG",
      type: "json",
      schemaVersion: 1,
    });
    expect(manifest.resourceTemplate.secretNames).toEqual([
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_WEBHOOK_SECRET",
      "WECHAT_CREDENTIALS",
      "ADMIN_TOKEN",
    ]);
    expect(manifest.resourceTemplate.secretNamePatterns).toEqual([
      "^MODEL_KEY_[A-Z0-9_]{1,64}$",
      "^MCP_[A-Z0-9_]{1,64}$",
    ]);
    expect(manifest.resourceTemplate.plainVars).toEqual(["ACTIVE_CHANNEL", "PUBLIC_BASE_URL"]);
    expect(manifest.resourceTemplate.crons).toEqual(["*/5 * * * *"]);
    expect(manifest.resourceTemplate.installParameters.map((parameter) => parameter.key)).toEqual([
      "workerName",
      "r2BucketName",
      "PUBLIC_BASE_URL",
      "owner",
    ]);
    expect(manifest.upgrade).toEqual({ minFromVersion: "1.0.0", irreversibleMigrations: [] });
  });

  it("requires an explicit minFromVersion", () => {
    expect(() =>
      buildManifestFromFiles({
        template: readTemplate(),
        configSchema: readSchema(),
        version: "0.1.1",
        keyId: "deskwand-release-test",
        files: sampleFiles(),
      }),
    ).toThrow(/minFromVersion/);
  });

  it("rejects a minFromVersion newer than the release version", () => {
    expect(() => build({ version: "0.1.1", minFromVersion: "1.0.0" })).toThrow(/minFromVersion/);
    expect(() => build({ version: "0.1.1", minFromVersion: "0.1.2" })).toThrow(/minFromVersion/);
  });

  it("accepts a minFromVersion at or below the release version", () => {
    expect(build({ version: "0.1.1", minFromVersion: "0.1.0" }).manifest.upgrade.minFromVersion).toBe(
      "0.1.0",
    );
    expect(build({ version: "0.1.1", minFromVersion: "0.1.1" }).manifest.upgrade.minFromVersion).toBe(
      "0.1.1",
    );
  });

  it("treats a prerelease minFromVersion as older than its release", () => {
    expect(build({ version: "0.1.1", minFromVersion: "0.1.1-beta.1" }).manifest.upgrade.minFromVersion).toBe(
      "0.1.1-beta.1",
    );
    expect(() => build({ version: "0.1.1-beta.1", minFromVersion: "0.1.1" })).toThrow(/minFromVersion/);
  });

  it("orders versions exactly as the Go verifier does", () => {
    // Shared table: desktop/internal/release/version_test.go asserts the same
    // expectations, so the builder cannot sign a floor the client reads
    // differently.
    const fixture: { cases: { left: string; right: string; expect: number | null }[] } = JSON.parse(
      readFileSync(join(repoRoot, "contracts", "fixtures", "release", "version-order.json"), "utf8"),
    );
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const testCase of fixture.cases) {
      const comparison = compareReleaseVersions(testCase.left, testCase.right);
      expect(
        comparison ?? null,
        `${testCase.left} vs ${testCase.right}`,
      ).toBe(testCase.expect);
    }
  });

  it("requires secret name patterns in the template", () => {
    const missing = { ...readTemplate() } as Partial<ReleaseTemplate>;
    delete missing.secretNamePatterns;
    expect(() => build({ template: missing as ReleaseTemplate })).toThrow(
      /secretNamePatterns/,
    );

    const empty = { ...readTemplate(), secretNamePatterns: [] };
    expect(() => build({ template: empty })).toThrow(/secretNamePatterns/);
  });

  it("does not embed maintainer domains, owner IDs or a fixed bucket name", () => {
    const text = build().manifestBytes.toString("utf8");

    for (const forbidden of [
      "example",
      "your-worker.workers.dev",
      "my-artifacts",
      "100000001",
      "telegramUserIds",
      "https://bot.",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("PUBLIC_BASE_URL");
    expect(text).toContain("DESKWAND_CONFIG");
  });

  it("rejects unsafe and Windows-reserved paths", () => {
    const badPaths = [
      "/etc/passwd",
      "C:\\Windows\\evil.js",
      "C:evil.js",
      "../escape.js",
      "a/../../b.js",
      "a/./b.js",
      "chunks\\extra.js",
      "",
      "chunks/",
      "a//b.js",
      "a:b.js",
      "CON",
      "con.js",
      "COM1",
      "lpt9.txt",
      "aux.js",
      "NUL",
      "PRN",
      "index.js.",
      "index.js ",
      "a\x01b.js",
      "a b.js",
      "é.js",
    ];

    for (const path of badPaths) {
      expect(() => assertSafeRelativePath(path), path).toThrow();
      expect(
        () =>
          build({
            files: new Map([
              ["index.js", Buffer.from("export default {};\n")],
              [path, Buffer.from("x")],
            ]),
          }),
        path,
      ).toThrow();
    }
  });

  it("rejects duplicate file entries after NFC and lowercase normalization", () => {
    expect(() =>
      validateFileEntries([
        { path: "Index.js", bytes: Buffer.from("a") },
        { path: "index.js", bytes: Buffer.from("b") },
      ]),
    ).toThrow(/duplicate release file after normalization/);

    expect(pathComparisonKey("Cafe\u0301.js")).toBe(pathComparisonKey("Café.js"));
    expect(() =>
      validateFileEntries([
        { path: "Cafe\u0301.js", bytes: Buffer.from("a") },
        { path: "Café.js", bytes: Buffer.from("b") },
      ]),
    ).toThrow(/duplicate release file after normalization/);
  });

  it("rejects a file above the uncompressed per-file sanity bound", () => {
    expect(() =>
      validateFileEntries([
        { path: "index.js", bytes: Buffer.alloc(MAX_FILE_SANITY_BYTES + 1) },
      ]),
    ).toThrow(/sanity bound/);
  });

  it("rejects a package above the uncompressed total sanity bound", () => {
    const part = Buffer.alloc(MAX_FILE_SANITY_BYTES);
    expect(MAX_FILE_SANITY_BYTES * 2 + 1).toBeGreaterThan(MAX_TOTAL_SANITY_BYTES);
    expect(() =>
      validateFileEntries([
        { path: "index.js", bytes: part },
        { path: "chunks/extra.js", bytes: part },
        { path: "chunks/third.js", bytes: Buffer.from("z") },
      ]),
    ).toThrow(/sanity bound/);
  });

  it("rejects a module set above the free-plan compressed limit", () => {
    const files = new Map([
      ["index.js", Buffer.from("export default {};\n")],
      ["chunks/noise.bin", randomBytes(MAX_COMPRESSED_BYTES)],
    ]);
    const entries = [...files].map(([path, bytes]) => ({ path, bytes }));
    expect(compressedSizeOf(entries)).toBeGreaterThan(MAX_COMPRESSED_BYTES);
    expect(() => build({ files })).toThrow(/compressedSize/);
  });

  it("rejects an entrypoint that is not in the module set", () => {
    const files = new Map([["chunks/extra.js", Buffer.from("export const extra = 1;\n")]]);
    expect(() => build({ files })).toThrow(/entrypoint index\.js is not present/);
  });

  it("rejects entrypoint mismatches between the manifest and template", () => {
    const template = readTemplate();
    template.entrypoint = "other.js";
    expect(() => build({ template, entrypoint: "index.js" })).toThrow(
      /does not match resource template entrypoint/,
    );

    const unsafe = readTemplate();
    unsafe.entrypoint = "../escape.js";
    expect(() => build({ template: unsafe, entrypoint: "../escape.js" })).toThrow();
  });

  it("rejects empty or repeated AI binding names", () => {
    const empty = readTemplate();
    empty.aiBindings = [{ name: "" }];
    expect(() => build({ template: empty })).toThrow(/aiBindings\[0\]\.name/);

    const repeated = readTemplate();
    repeated.aiBindings = [{ name: "AI" }, { name: "AI" }];
    expect(() => build({ template: repeated })).toThrow(/repeats the name AI/);
  });

  it("rejects migrations for unbound DO classes and DO classes without migrations", () => {
    const ghost = readTemplate();
    ghost.migrations.push({ tag: "v5", newSqliteClasses: ["GhostDO"] });
    expect(() => build({ template: ghost })).toThrow(/unknown Durable Object class/);

    const extra = readTemplate();
    extra.durableObjects.push({ name: "EXTRA", className: "ExtraDO" });
    expect(() => build({ template: extra })).toThrow(/has no migration entry/);
  });

  it("rejects R2 and variable parameter keys not declared by install parameters", () => {
    const r2 = readTemplate();
    r2.r2Buckets[0].parameterKey = "missingBucket";
    expect(() => build({ template: r2 })).toThrow(/parameterKey is not an install parameter/);

    const variable = readTemplate();
    variable.vars[0].parameterKey = "MISSING_VAR";
    expect(() => build({ template: variable })).toThrow(/parameterKey is not an install parameter/);
  });

  it("signs and verifies exact manifest bytes, and rejects a mutated field", () => {
    const built = build();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");

    const signature = signManifest(built.manifestBytes, privateKey);
    expect(verifyManifestSignature(built.manifestBytes, signature, publicKey)).toBe(true);

    const mutated = Buffer.from(
      built.manifestBytes.toString("utf8").replace('"version":"1.0.0"', '"version":"1.0.1"'),
      "utf8",
    );
    expect(mutated.equals(built.manifestBytes)).toBe(false);
    expect(verifyManifestSignature(mutated, signature, publicKey)).toBe(false);

    const other = generateKeyPairSync("ed25519").publicKey;
    expect(verifyManifestSignature(built.manifestBytes, signature, other)).toBe(false);
  });

  it("refuses to sign without a private key and rejects non-Ed25519 keys", () => {
    expect(() => loadSigningKey({})).toThrow(/DESKWAND_RELEASE_SIGNING_KEY/);
    expect(() =>
      loadSigningKey({
        DESKWAND_RELEASE_SIGNING_KEY: generateKeyPairSync("rsa", {
          modulusLength: 2048,
        }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      }),
    ).toThrow(/ed25519/);
  });

  it("loads a PEM key passed through an escaped environment value", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const loaded = loadSigningKey({
      DESKWAND_RELEASE_SIGNING_KEY: pem.replaceAll("\n", "\\n"),
    });
    expect(loaded.asymmetricKeyType).toBe("ed25519");
  });
});

describe("release template consistency", () => {
  it("matches wrangler.jsonc on migrations, bindings, cron and compatibility", () => {
    const wrangler = JSON.parse(readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8")) as {
      compatibility_date: string;
      compatibility_flags?: string[];
      durable_objects: { bindings: Array<{ name: string; class_name: string }> };
      migrations: Array<{ tag: string; new_sqlite_classes?: string[] }>;
      r2_buckets: Array<{ binding: string; bucket_name: string }>;
      triggers: { crons: string[] };
      version_metadata: { binding: string };
    };
    const template = readTemplate();

    expect(template.compatibility).toEqual({
      date: wrangler.compatibility_date,
      flags: wrangler.compatibility_flags ?? [],
    });
    expect(template.durableObjects).toEqual(
      wrangler.durable_objects.bindings.map((binding) => ({
        name: binding.name,
        className: binding.class_name,
      })),
    );
    expect(template.migrations).toEqual(
      wrangler.migrations.map((migration) => ({
        tag: migration.tag,
        newSqliteClasses: migration.new_sqlite_classes ?? [],
      })),
    );
    expect(template.r2Buckets.map((binding) => binding.name)).toEqual(
      wrangler.r2_buckets.map((binding) => binding.binding),
    );
    expect(template.crons).toEqual(wrangler.triggers.crons);
    expect(template.versionMetadataBinding.name).toBe(wrangler.version_metadata.binding);
    expect(template.configBinding.name).toBe("DESKWAND_CONFIG");
    expect(template.configBinding.schemaVersion).toBe(1);
  });

  it("matches wrangler.jsonc observability settings exactly", () => {
    const wrangler = JSON.parse(readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8")) as {
      observability?: unknown;
    };
    const template = readTemplate();

    expect(template.observability).toEqual(wrangler.observability);
    expect(template.observability).toEqual({
      enabled: true,
      head_sampling_rate: 1,
      logs: { invocation_logs: false },
    });
  });

  it("declares exactly the Worker secrets from src/env.d.ts", () => {
    const envSource = readFileSync(join(repoRoot, "src", "env.d.ts"), "utf8");
    const secrets = [...envSource.matchAll(/^\s+([A-Z0-9_]+)\?:\s*string;\s*$/gm)]
      .map((match) => match[1])
      .filter((name) => name !== "ACTIVE_CHANNEL")
      .sort();

    // The release template keeps TELEGRAM_WEBHOOK_SECRET for old deployments;
    // the Worker itself no longer declares or reads it.
    const legacySecrets = ["TELEGRAM_WEBHOOK_SECRET"];
    const declared = [...readTemplate().secretNames]
      .filter((name) => !legacySecrets.includes(name))
      .sort();

    expect(secrets).toEqual(declared);
  });

  it("includes every plain var declared by wrangler.jsonc", () => {
    const wrangler = JSON.parse(readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8")) as {
      vars?: Record<string, string>;
    };
    const plainVars = [...readTemplate().plainVars].sort();
    for (const name of Object.keys(wrangler.vars ?? {})) {
      expect(plainVars).toContain(name);
    }
  });
});

describe("cross-language release fixture", () => {
  const manifestBytes = readFileSync(join(fixtureDir, "manifest.json"));
  const signatureText = readFileSync(join(fixtureDir, "manifest.sig"), "utf8").trim();
  const publicKeyPem = readFileSync(join(fixtureDir, "TEST-ONLY-signing-key.pub.pem"), "utf8");
  const privateKeyPem = readFileSync(join(fixtureDir, "TEST-ONLY-signing-key.pem"), "utf8");

  it("uses canonical bytes and a TEST ONLY key id", () => {
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as ReleaseManifest;
    expect(manifest.keyId).toBe("test-only-do-not-use");
    expect(manifest.compressedSize).toBeGreaterThan(0);
    expect(manifest.compressedSize).toBeLessThanOrEqual(MAX_COMPRESSED_BYTES);
    expect(canonicalJson(manifest)).toBe(manifestBytes.toString("utf8"));
    expect(manifest.resourceTemplate.observability).toEqual({
      enabled: true,
      head_sampling_rate: 1,
      logs: { invocation_logs: false },
    });
  });

  it("has a signature both languages can verify over the same bytes", () => {
    const publicKey = createPublicKey(publicKeyPem);
    const privateKey = createPrivateKey(privateKeyPem);

    expect(verifyManifestSignature(manifestBytes, signatureText, publicKey)).toBe(true);
    expect(signManifest(manifestBytes, privateKey)).toBe(signatureText);
  });

  it("lists hashes and sizes for files present in the fixture", () => {
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as ReleaseManifest;
    for (const file of manifest.files) {
      const bytes = readFileSync(join(fixtureDir, "files", ...file.path.split("/")));
      expect(sha256Hex(bytes), file.path).toBe(file.sha256);
      expect(bytes.byteLength, file.path).toBe(file.size);
    }
  });
});

describe("Wrangler dry-run integration", () => {
  it("collects generated modules without invoking a real deploy", async (context) => {
    let generated: ReturnType<typeof generateModules>;
    try {
      generated = generateModules({ cwd: repoRoot, timeoutMs: 90_000 });
    } catch (error) {
      context.skip(
        `wrangler dry-run unavailable in this environment: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    try {
      const files = collectModuleFiles(generated.moduleDir);
      expect(files.size).toBeGreaterThan(0);
      expect(files.has("index.js")).toBe(true);
      // Wrangler's README and source maps are not Worker modules.
      expect(files.has("README.md")).toBe(false);
      expect(files.has("index.js.map")).toBe(false);

      const text = [...files.values()].map((bytes) => Buffer.from(bytes).toString("utf8")).join("\n");
      for (const forbidden of ["example", "your-worker.workers.dev", "my-artifacts", "100000001"]) {
        expect(text).not.toContain(forbidden);
      }
    } finally {
      generated.cleanup();
    }
  }, 120_000);
});
