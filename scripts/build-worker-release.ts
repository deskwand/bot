/**
 * Builds a deterministic, signed-release-ready Worker package.
 *
 * Usage:
 *   npm run release:worker -- --version 1.0.0 --key-id deskwand-release-1
 *
 * The script only runs `wrangler deploy --dry-run`; it never contacts
 * Cloudflare. Generated modules and `manifest.json` are written to
 * `dist/worker-release/`. Signing is a separate step so the maintainer's
 * private key is only present when `npm run release:sign` runs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

/** Manifest shape version understood by this builder and the Go verifier. */
export const MANIFEST_VERSION = 1;

/** Deployment-config schema version this client can publish. */
export const SUPPORTED_CONFIG_SCHEMA_VERSION = 1;

/**
 * Release size limits.
 *
 * The supported plan is the Workers free plan, which allows 3 MB after
 * compression. The builder measures each module with gzip level 9 and sums
 * the results (conservative versus one combined gzip stream), records the sum
 * as `compressedSize`, and rejects anything above 3,000,000 bytes.
 *
 * The uncompressed bounds below are local sanity guards only, not Cloudflare
 * limits. The Go verifier declares the same constants; keep both sides in
 * sync.
 */
export const MAX_COMPRESSED_BYTES = 3_000_000;
export const MAX_FILE_SANITY_BYTES = 32 * 1024 * 1024; // 32 MiB
export const MAX_TOTAL_SANITY_BYTES = 64 * 1024 * 1024; // 64 MiB

/** The only Wrangler invocation this builder is allowed to make. */
export const WRANGLER_DRY_RUN_ARGS = ["deploy", "--dry-run"] as const;

export type Migration = {
  tag: string;
  newSqliteClasses?: string[];
};

export type ReleaseTemplate = {
  schemaVersion: number;
  entrypoint: string;
  compatibility: { date: string; flags: string[] };
  durableObjects: Array<{ name: string; className: string }>;
  r2Buckets: Array<{ name: string; parameterKey: string }>;
  versionMetadataBinding: { name: string };
  configBinding: { name: string; type: "json"; schemaVersion: number };
  secretNames: string[];
  plainVars: string[];
  crons: string[];
  vars: Array<{ name: string; parameterKey: string }>;
  migrations: Migration[];
  installParameters: Array<{ key: string; source: string }>;
};

export type FileEntry = {
  path: string;
  sha256: string;
  size: number;
};

export type ReleaseManifest = {
  manifestVersion: number;
  keyId: string;
  version: string;
  entrypoint: string;
  files: FileEntry[];
  compressedSize: number;
  configSchemaVersion: number;
  compatibility: { date: string; flags: string[] };
  resourceTemplate: ReleaseTemplate;
  migrations: Migration[];
  upgrade: {
    minFromVersion: string;
    irreversibleMigrations: string[];
  };
};

export type InputFile = { path: string; bytes: Uint8Array };

export type BuildManifestOptions = {
  template: ReleaseTemplate;
  configSchema: unknown;
  version: string;
  keyId: string;
  files: Map<string, Uint8Array> | ReadonlyArray<InputFile>;
  entrypoint?: string;
  minFromVersion?: string;
  irreversibleMigrations?: string[];
};

export type BuiltManifest = {
  manifest: ReleaseManifest;
  manifestBytes: Buffer;
  files: InputFile[];
  totalBytes: number;
  compressedSize: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertUniqueStrings(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} contains a duplicate: ${value}`);
    seen.add(value);
  }
}

/** Validates the parts of the resource template this builder depends on. */
export function assertReleaseTemplate(value: unknown): asserts value is ReleaseTemplate {
  const template = requireRecord(value, "release template");
  if (template.schemaVersion !== 1) {
    throw new Error(`unsupported release template schemaVersion: ${String(template.schemaVersion)}`);
  }
  const entrypoint = requireString(template.entrypoint, "release template entrypoint");
  assertSafeRelativePath(entrypoint);

  const compatibility = requireRecord(template.compatibility, "release template compatibility");
  requireString(compatibility.date, "release template compatibility.date");
  requireStringArray(compatibility.flags, "release template compatibility.flags");

  for (const key of ["durableObjects", "r2Buckets", "vars", "installParameters", "crons"] as const) {
    if (!Array.isArray(template[key])) {
      throw new Error(`release template ${key} must be an array`);
    }
  }
  const versionMetadata = requireRecord(
    template.versionMetadataBinding,
    "release template versionMetadataBinding",
  );
  requireString(versionMetadata.name, "release template versionMetadataBinding.name");

  const configBinding = requireRecord(template.configBinding, "release template configBinding");
  requireString(configBinding.name, "release template configBinding.name");
  if (configBinding.type !== "json") {
    throw new Error(`release template configBinding.type must be "json", got ${String(configBinding.type)}`);
  }
  if (configBinding.schemaVersion !== SUPPORTED_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `release template configBinding.schemaVersion ${String(configBinding.schemaVersion)} is not the supported version ${SUPPORTED_CONFIG_SCHEMA_VERSION}`,
    );
  }

  const secretNames = requireStringArray(template.secretNames, "release template secretNames");
  assertUniqueStrings(secretNames, "release template secretNames");
  const plainVars = requireStringArray(template.plainVars, "release template plainVars");
  assertUniqueStrings(plainVars, "release template plainVars");
  if (!plainVars.includes("PUBLIC_BASE_URL")) {
    throw new Error("release template plainVars must include PUBLIC_BASE_URL");
  }

  const durableClasses = new Set<string>();
  for (const [index, binding] of (template.durableObjects as unknown[]).entries()) {
    const entry = requireRecord(binding, `release template durableObjects[${index}]`);
    requireString(entry.name, `release template durableObjects[${index}].name`);
    const className = requireString(
      entry.className,
      `release template durableObjects[${index}].className`,
    );
    if (durableClasses.has(className)) {
      throw new Error(`duplicate Durable Object class in release template: ${className}`);
    }
    durableClasses.add(className);
  }

  const migrations = template.migrations;
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new Error("release template must carry the full Durable Object migration history");
  }
  const tags = new Set<string>();
  const migratedClasses = new Set<string>();
  for (const migration of migrations) {
    const entry = requireRecord(migration, "release template migration");
    const tag = requireString(entry.tag, "release template migration.tag");
    if (tags.has(tag)) throw new Error(`duplicate migration tag: ${tag}`);
    tags.add(tag);
    if (entry.newSqliteClasses !== undefined) {
      for (const className of requireStringArray(
        entry.newSqliteClasses,
        "release template migration.newSqliteClasses",
      )) {
        migratedClasses.add(className);
      }
    }
  }
  for (const className of migratedClasses) {
    if (!durableClasses.has(className)) {
      throw new Error(`migration references unknown Durable Object class: ${className}`);
    }
  }
  for (const className of durableClasses) {
    if (!migratedClasses.has(className)) {
      throw new Error(`Durable Object class has no migration entry: ${className}`);
    }
  }

  for (const [index, cron] of (template.crons as unknown[]).entries()) {
    requireString(cron, `release template crons[${index}]`);
  }

  const installParameters = (template.installParameters as unknown[]).map((parameter, index) => {
    const entry = requireRecord(parameter, `release template installParameters[${index}]`);
    return {
      key: requireString(entry.key, `release template installParameters[${index}].key`),
      source: requireString(entry.source, `release template installParameters[${index}].source`),
    };
  });
  for (const required of ["workerName", "r2BucketName", "PUBLIC_BASE_URL", "owner"]) {
    if (!installParameters.some((parameter) => parameter.key === required)) {
      throw new Error(`release template is missing install parameter ${required}`);
    }
  }
  const owner = installParameters.find((parameter) => parameter.key === "owner");
  if (owner?.source !== "DESKWAND_CONFIG") {
    throw new Error("release template owner parameter must come from DESKWAND_CONFIG");
  }
  const installKeys = new Set(installParameters.map((parameter) => parameter.key));

  for (const [index, binding] of (template.r2Buckets as unknown[]).entries()) {
    const entry = requireRecord(binding, `release template r2Buckets[${index}]`);
    requireString(entry.name, `release template r2Buckets[${index}].name`);
    const parameterKey = requireString(
      entry.parameterKey,
      `release template r2Buckets[${index}].parameterKey`,
    );
    if (!installKeys.has(parameterKey)) {
      throw new Error(`R2 binding parameterKey is not an install parameter: ${parameterKey}`);
    }
  }
  for (const [index, variable] of (template.vars as unknown[]).entries()) {
    const entry = requireRecord(variable, `release template vars[${index}]`);
    requireString(entry.name, `release template vars[${index}].name`);
    const parameterKey = requireString(
      entry.parameterKey,
      `release template vars[${index}].parameterKey`,
    );
    if (!installKeys.has(parameterKey)) {
      throw new Error(`variable parameterKey is not an install parameter: ${parameterKey}`);
    }
  }
}

/**
 * Reads `configSchemaVersion` from the authoritative JSON Schema (`const` of
 * the `schemaVersion` property) instead of duplicating it in the builder.
 */
export function readConfigSchemaVersion(schema: unknown): number {
  const root = requireRecord(schema, "config schema");
  const properties = requireRecord(root.properties, "config schema properties");
  const schemaVersion = requireRecord(properties.schemaVersion, "config schema schemaVersion");
  const value = schemaVersion.const;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("config schema properties.schemaVersion.const must be an integer");
  }
  if (value !== SUPPORTED_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `config schema version ${value} is not supported by manifest v${MANIFEST_VERSION} builders`,
    );
  }
  return value;
}

/** Comparison key for Windows/NFC path collisions. */
export function pathComparisonKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

const SEGMENT_PATTERN = /^[A-Za-z0-9._@+-]+$/;
const RESERVED_DEVICE_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Rejects paths that are not safe on both POSIX and Windows: absolute paths,
 * parent/dot segments, backslashes, colons, control characters, characters
 * outside the portable whitelist, trailing dots/spaces and Windows device
 * names.
 */
export function assertSafeRelativePath(path: string): void {
  if (path.length === 0) throw new Error("file path is empty");
  if (CONTROL_CHARACTER.test(path)) {
    throw new Error(`file path contains a control character: ${JSON.stringify(path)}`);
  }
  if (path.startsWith("/") || path.startsWith("\\")) {
    throw new Error(`absolute file path is not allowed: ${path}`);
  }
  if (path.includes("\\")) {
    throw new Error(`backslash separators are not allowed: ${path}`);
  }
  if (path.includes(":")) {
    throw new Error(`colon is not allowed in a portable file path: ${path}`);
  }

  for (const segment of path.split("/")) {
    if (segment === "") {
      throw new Error(`file path contains an empty segment: ${path}`);
    }
    if (segment === "." || segment === "..") {
      throw new Error(`file path contains a dot or parent segment: ${path}`);
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        `file path segment must match [A-Za-z0-9._@+-]: ${JSON.stringify(segment)} in ${path}`,
      );
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      throw new Error(`file path segment has a trailing dot or space: ${path}`);
    }
    if (RESERVED_DEVICE_PATTERN.test(segment)) {
      throw new Error(`file path segment is a reserved Windows device name: ${segment}`);
    }
  }
}

/**
 * Validates a candidate file list. Takes an array rather than a map so that
 * duplicate paths can be detected (a Map would silently collapse them).
 * Collisions are detected after Unicode NFC normalization and lowercasing so
 * case-insensitive and decomposed filenames cannot shadow each other.
 */
export function validateFileEntries(entries: ReadonlyArray<InputFile>): { totalBytes: number } {
  if (entries.length === 0) throw new Error("release package contains no modules");

  // Detect collisions before path validation so Unicode-normalization and
  // case collisions are reported as duplicates even though the portable
  // whitelist would also reject a non-ASCII path.
  const seen = new Set<string>();
  for (const entry of entries) {
    const comparisonKey = pathComparisonKey(entry.path);
    if (seen.has(comparisonKey)) {
      throw new Error(`duplicate release file after normalization: ${entry.path}`);
    }
    seen.add(comparisonKey);
  }

  let totalBytes = 0;
  for (const entry of entries) {
    assertSafeRelativePath(entry.path);

    if (entry.bytes.byteLength > MAX_FILE_SANITY_BYTES) {
      throw new Error(
        `release file ${entry.path} is ${entry.bytes.byteLength} bytes; uncompressed per-file sanity bound is ${MAX_FILE_SANITY_BYTES}`,
      );
    }
    if (entry.bytes.byteLength > MAX_TOTAL_SANITY_BYTES - totalBytes) {
      throw new Error(
        `release package exceeds the ${MAX_TOTAL_SANITY_BYTES} byte uncompressed total sanity bound`,
      );
    }
    totalBytes += entry.bytes.byteLength;
  }
  return { totalBytes };
}

/** Gzip level 9 per module, summed. Conservative versus one combined stream. */
export function compressedSizeOf(files: ReadonlyArray<InputFile>): number {
  let total = 0;
  for (const file of files) {
    total += gzipSync(Buffer.from(file.bytes), { level: 9 }).byteLength;
  }
  return total;
}

/** Recursively sorted object keys, no whitespace. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key]);
    return sorted;
  }
  return value;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareModulePaths(left: string, right: string): number {
  // The Go verifier compares Go strings, which are UTF-8 bytes. Sorting by
  // UTF-16 code units would disagree for some non-BMP characters.
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizeFiles(
  files: Map<string, Uint8Array> | ReadonlyArray<InputFile>,
): InputFile[] {
  const entries = files instanceof Map
    ? Array.from(files, ([path, bytes]) => ({ path, bytes }))
    : Array.from(files);
  return [...entries].sort((left, right) => compareModulePaths(left.path, right.path));
}

/**
 * Pure manifest builder. Tests feed a fixed module set; the CLI feeds files
 * collected from the Wrangler dry-run output.
 */
export function buildManifestFromFiles(options: BuildManifestOptions): BuiltManifest {
  const { template } = options;
  assertReleaseTemplate(template);

  const version = requireString(options.version, "release version");
  const keyId = requireString(options.keyId, "release keyId");
  const entrypoint = options.entrypoint ?? template.entrypoint;
  assertSafeRelativePath(entrypoint);

  const configSchemaVersion = readConfigSchemaVersion(options.configSchema);
  const files = normalizeFiles(options.files);
  const { totalBytes } = validateFileEntries(files);
  const compressedSize = compressedSizeOf(files);
  if (compressedSize > MAX_COMPRESSED_BYTES) {
    throw new Error(
      `release compressedSize ${compressedSize} exceeds the ${MAX_COMPRESSED_BYTES} byte free-plan limit`,
    );
  }

  if (!files.some((file) => file.path === entrypoint)) {
    throw new Error(`entrypoint ${entrypoint} is not present in the generated modules`);
  }
  if (entrypoint !== template.entrypoint) {
    throw new Error(
      `generated entrypoint ${entrypoint} does not match resource template entrypoint ${template.entrypoint}`,
    );
  }

  const irreversibleMigrations = options.irreversibleMigrations ?? [];
  for (const tag of irreversibleMigrations) {
    if (!template.migrations.some((migration) => migration.tag === tag)) {
      throw new Error(`irreversible migration ${tag} is not in the resource template history`);
    }
  }

  const manifest: ReleaseManifest = {
    manifestVersion: MANIFEST_VERSION,
    keyId,
    version,
    entrypoint,
    files: files.map((file) => ({
      path: file.path,
      sha256: sha256Hex(file.bytes),
      size: file.bytes.byteLength,
    })),
    compressedSize,
    configSchemaVersion,
    compatibility: {
      date: template.compatibility.date,
      flags: [...template.compatibility.flags],
    },
    resourceTemplate: template,
    migrations: template.migrations,
    upgrade: {
      minFromVersion: options.minFromVersion ?? "1.0.0",
      irreversibleMigrations: [...irreversibleMigrations],
    },
  };

  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
  return { manifest, manifestBytes, files, totalBytes, compressedSize };
}

/**
 * Collects generated Worker modules. Wrangler writes a README and, when
 * source-map upload is enabled, `.map` files; neither is a Worker module, so
 * both are excluded from the signed package.
 */
export function collectModuleFiles(moduleDir: string): Map<string, Uint8Array> {
  if (!existsSync(moduleDir)) throw new Error(`module directory does not exist: ${moduleDir}`);

  const files = new Map<string, Uint8Array>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === "README.md" || entry.name === ".DS_Store" || entry.name.endsWith(".map")) {
        continue;
      }
      const path = relative(moduleDir, fullPath).split(sep).join("/");
      files.set(path, readFileSync(fullPath));
    }
  };
  walk(moduleDir);

  const sorted = new Map(
    [...files.entries()].sort(([left], [right]) => compareModulePaths(left, right)),
  );
  if (sorted.size === 0) throw new Error(`no Worker modules found in ${moduleDir}`);
  return sorted;
}

export type GeneratedModules = {
  moduleDir: string;
  cleanup(): void;
};

/**
 * Runs Wrangler's compile-and-dry-run path. `--dry-run` is mandatory; there is
 * no code path in this script that can upload a Worker.
 */
export function generateModules(options: {
  cwd?: string;
  config?: string;
  compatibility?: { date: string; flags: string[] };
  timeoutMs?: number;
} = {}): GeneratedModules {
  const root = mkdtempSync(join(tmpdir(), "deskwand-worker-release-"));
  const moduleDir = join(root, "modules");
  const args = ["wrangler", ...WRANGLER_DRY_RUN_ARGS, "--outdir", moduleDir];
  if (options.config) args.push("--config", options.config);
  if (options.compatibility) {
    args.push("--compatibility-date", options.compatibility.date);
    for (const flag of options.compatibility.flags) {
      args.push("--compatibility-flag", flag);
    }
  }

  const result = spawnSync("npx", args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeoutMs ?? 180_000,
  });

  const cleanup = () => rmSync(root, { recursive: true, force: true });
  if (result.error) {
    cleanup();
    throw new Error(`wrangler dry-run could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    cleanup();
    const detail = (result.stderr || result.stdout || "").trim().slice(-2000);
    throw new Error(`wrangler dry-run failed with status ${String(result.status)}: ${detail}`);
  }
  if (!existsSync(moduleDir) || !statSync(moduleDir).isDirectory()) {
    cleanup();
    throw new Error("wrangler dry-run produced no module directory");
  }
  return { moduleDir, cleanup };
}

export function readTemplateFile(path: string): ReleaseTemplate {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertReleaseTemplate(parsed);
  return parsed;
}

function argument(name: string, argv: string[]): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function releaseVersionDefault() {
  try {
    const pkg: unknown = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    if (isRecord(pkg) && typeof pkg.version === "string") return pkg.version;
  } catch {
    // The caller gets an explicit usage error below.
  }
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const version =
    argument("version", argv) ??
    process.env.DESKWAND_RELEASE_VERSION ??
    releaseVersionDefault() ??
    fail("缺少发布版本：使用 --version <semver> 或 DESKWAND_RELEASE_VERSION");
  const keyId =
    argument("key-id", argv) ??
    process.env.DESKWAND_RELEASE_KEY_ID ??
    fail("缺少签名 keyId：使用 --key-id <id> 或 DESKWAND_RELEASE_KEY_ID");
  const outputDir = resolve(argument("output", argv) ?? "dist/worker-release");
  const templatePath = resolve(argument("template", argv) ?? "contracts/release-template.json");
  const schemaPath = resolve(
    argument("config-schema", argv) ?? "contracts/deployment-config.schema.json",
  );

  const template = readTemplateFile(templatePath);
  const configSchema: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
  const generated = generateModules({
    config: argument("wrangler-config", argv),
    compatibility: template.compatibility,
    timeoutMs: 180_000,
  });

  try {
    const files = collectModuleFiles(generated.moduleDir);
    const built = buildManifestFromFiles({
      template,
      configSchema,
      version: version as string,
      keyId: keyId as string,
      files,
      minFromVersion: argument("min-from-version", argv),
    });

    const moduleOutput = join(outputDir, "modules");
    mkdirSync(moduleOutput, { recursive: true });
    for (const file of built.files) {
      const destination = join(moduleOutput, ...file.path.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.bytes);
    }
    const manifestPath = join(outputDir, "manifest.json");
    writeFileSync(manifestPath, built.manifestBytes);

    console.log("Worker release built");
    console.log(`  version:    ${built.manifest.version}`);
    console.log(`  keyId:      ${built.manifest.keyId}`);
    console.log(`  entrypoint: ${built.manifest.entrypoint}`);
    console.log(`  files:      ${built.files.length} (${built.totalBytes} bytes uncompressed)`);
    console.log(`  gzip:       ${built.compressedSize} bytes (free-plan limit ${MAX_COMPRESSED_BYTES})`);
    console.log(`  manifest:   ${manifestPath}`);
    console.log("  signature:  not written; run `npm run release:sign` with the signing key");
  } finally {
    generated.cleanup();
  }
}

// Only run when executed directly, so the builder stays importable in tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
