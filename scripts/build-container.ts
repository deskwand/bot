/**
 * Builds the container bundle: the Worker's dry-run modules, the `front` and
 * `store` services, and the workerd config template the entrypoint fills in.
 *
 * Usage:
 *   npm run build:container -- --version 1.2.3
 *
 * The template keeps three placeholders for the entrypoint to replace:
 * `@@LISTEN@@`, `@@DATA_DIR@@` and the `# @@ENV_BINDINGS@@` line.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

export type ModuleEntry = { name: string; type: "esModule" | "wasm" };

export type DoBinding = { binding: string; className: string };

const ENTRY_MODULE = "index.js";
const DEFAULT_VERSION = "dev";

/**
 * workerd's builtin `cloudflare:email` module imports this internal module.
 * `agents` imports `cloudflare:email` at module scope, so the main worker does
 * not evaluate without it. The class is never constructed by our code paths
 * (there is no send-email binding); it only keeps the import resolvable.
 */
const EMAIL_INTERNAL_MODULE = "email-internal.js";
const EMAIL_INTERNAL_SOURCE = `class EmailMessage {
  constructor(from, to, raw) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}

export default { EmailMessage };
`;

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/** Entry module `index.js` first, then the rest sorted by name; skips README.md and *.map. */
export function collectModules(dir: string): ModuleEntry[] {
  const modules: ModuleEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === "README.md" || entry.name.endsWith(".map")) continue;
    if (entry.name.endsWith(".js")) {
      modules.push({ name: entry.name, type: "esModule" });
    } else if (entry.name.endsWith(".wasm")) {
      modules.push({ name: entry.name, type: "wasm" });
    } else {
      throw new Error(`unexpected file in ${dir}: ${entry.name}`);
    }
  }

  const entrypoint = modules.find((module) => module.name === ENTRY_MODULE);
  if (entrypoint === undefined) {
    throw new Error(`no ${ENTRY_MODULE} in ${dir}`);
  }
  const rest = modules
    .filter((module) => module.name !== ENTRY_MODULE)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return [entrypoint, ...rest];
}

export function doBindings(wranglerConfig: unknown): DoBinding[] {
  if (typeof wranglerConfig !== "object" || wranglerConfig === null) {
    throw new Error("wrangler config must be an object");
  }
  const durableObjects = (wranglerConfig as { durable_objects?: unknown })
    .durable_objects;
  if (typeof durableObjects !== "object" || durableObjects === null) {
    throw new Error("wrangler config has no durable_objects");
  }
  const bindings = (durableObjects as { bindings?: unknown }).bindings;
  if (!Array.isArray(bindings)) {
    throw new Error("wrangler config durable_objects.bindings must be an array");
  }

  return bindings.map((value: unknown, index: number) => {
    if (typeof value !== "object" || value === null) {
      throw new Error(`durable_objects.bindings[${index}] must be an object`);
    }
    const entry = value as { name?: unknown; class_name?: unknown };
    return {
      binding: requireString(entry.name, `durable_objects.bindings[${index}].name`),
      className: requireString(
        entry.class_name,
        `durable_objects.bindings[${index}].class_name`,
      ),
    };
  });
}

export function uniqueKeyFor(className: string): string {
  return `deskwand-${className}`;
}

function renderModules(modules: ModuleEntry[]): string {
  return modules
    .map((module) =>
      module.type === "esModule"
        ? `    (name = "${module.name}", esModule = embed "main/${module.name}"),`
        : `    (name = "${module.name}", wasm = embed "main/${module.name}"),`,
    )
    .join("\n");
}

function renderBindings(durableObjects: DoBinding[], version: string): string {
  if (version.includes('"') || version.includes("\\")) {
    throw new Error("version must not contain quotes or backslashes");
  }

  const lines = durableObjects.map(
    ({ binding, className }) =>
      `    (name = "${binding}", durableObjectNamespace = "${className}"),`,
  );
  lines.push(
    `    (name = "ARTIFACT_STORE", durableObjectNamespace = (className = "StoreDO", serviceName = "store")),`,
  );
  lines.push(
    `    (name = "CF_VERSION_METADATA", json = "{\\"id\\":\\"container-${version}\\",\\"tag\\":\\"\\",\\"timestamp\\":\\"\\"}"),`,
  );
  lines.push("    # @@ENV_BINDINGS@@");
  return lines.join("\n");
}

function renderNamespaces(durableObjects: DoBinding[]): string {
  return durableObjects
    .map(
      ({ className }) =>
        `    (className = "${className}", uniqueKey = "${uniqueKeyFor(className)}", enableSql = true),`,
    )
    .join("\n");
}

export function renderTemplate(input: {
  modules: ModuleEntry[];
  compatibilityDate: string;
  compatibilityFlags: string[];
  durableObjects: DoBinding[];
  version: string;
}): string {
  const flags = input.compatibilityFlags.map((flag) => `"${flag}"`).join(", ");

  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "front", worker = .front),
    (name = "main", worker = .main),
    (name = "store", worker = .store),
    (name = "data", disk = (path = "@@DATA_DIR@@", writable = true)),
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [(name = "http", address = "@@LISTEN@@", http = (), service = "front")],
  extensions = [
    (modules = [
      (name = "cloudflare-internal:email", internal = true, esModule = embed "main/${EMAIL_INTERNAL_MODULE}"),
    ]),
  ],
);

const main :Workerd.Worker = (
  modules = [
${renderModules(input.modules)}
  ],
  compatibilityDate = "${input.compatibilityDate}",
  compatibilityFlags = [${flags}],
  bindings = [
${renderBindings(input.durableObjects, input.version)}
  ],
  durableObjectNamespaces = [
${renderNamespaces(input.durableObjects)}
  ],
  durableObjectStorage = (localDisk = "data"),
  globalOutbound = "internet",
);

const front :Workerd.Worker = (
  modules = [(name = "index.js", esModule = embed "front/index.js")],
  compatibilityDate = "${input.compatibilityDate}",
  bindings = [
    (name = "MAIN", service = "main"),
    (name = "TICKER", durableObjectNamespace = "TickerDO"),
  ],
  durableObjectNamespaces = [(className = "TickerDO", uniqueKey = "${uniqueKeyFor("TickerDO")}", enableSql = true)],
  durableObjectStorage = (localDisk = "data"),
);

const store :Workerd.Worker = (
  modules = [(name = "index.js", esModule = embed "store/index.js")],
  compatibilityDate = "${input.compatibilityDate}",
  durableObjectNamespaces = [(className = "StoreDO", uniqueKey = "${uniqueKeyFor("StoreDO")}", enableSql = true)],
  durableObjectStorage = (localDisk = "data"),
);
`;
}

function argument(name: string, argv: string[]): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readWranglerConfig(root: string): unknown {
  return JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
}

async function buildService(
  root: string,
  entry: string,
  target: string,
  platform: "browser" | "node" = "browser",
): Promise<void> {
  await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "esm",
    // A node platform keeps `node:*` imports out of the bundle; workerd's
    // workers resolve their own builtins instead.
    platform,
    external: ["cloudflare:*"],
    outfile: target,
  });
}

async function main(): Promise<void> {
  const root = process.cwd();
  const version = argument("version", process.argv.slice(2)) ?? DEFAULT_VERSION;
  const outDir = resolve(root, "dist/container");
  const mainDir = join(outDir, "main");

  rmSync(mainDir, { recursive: true, force: true });
  mkdirSync(mainDir, { recursive: true });

  const wrangler = spawnSync(
    "npx",
    ["wrangler", "deploy", "--dry-run", "--outdir", mainDir],
    { cwd: root, stdio: "inherit", env: { ...process.env, CI: "1" } },
  );
  if (wrangler.status !== 0) {
    throw new Error(
      `wrangler dry-run failed with status ${String(wrangler.status)}`,
    );
  }

  await buildService(
    root,
    "container/front/index.ts",
    join(outDir, "front/index.js"),
  );
  await buildService(
    root,
    "container/store/index.ts",
    join(outDir, "store/index.js"),
  );
  // `.mjs`, not `.js`: the sandbox image runs this file under node, which needs
  // the extension to treat a package-less file as ESM. `front` and `store` stay
  // `.js` because workerd loads them.
  await buildService(
    root,
    "container/sandbox/index.ts",
    join(outDir, "sandbox/index.mjs"),
    "node",
  );

  const config = readWranglerConfig(root) as {
    compatibility_date?: unknown;
    compatibility_flags?: unknown;
  };
  const compatibilityDate = requireString(
    config.compatibility_date,
    "wrangler config compatibility_date",
  );
  const compatibilityFlags = config.compatibility_flags ?? [];
  if (
    !Array.isArray(compatibilityFlags) ||
    compatibilityFlags.some((flag) => typeof flag !== "string")
  ) {
    throw new Error("wrangler config compatibility_flags must be an array of strings");
  }

  writeFileSync(
    join(outDir, "config.capnp.template"),
    renderTemplate({
      modules: collectModules(mainDir),
      compatibilityDate,
      compatibilityFlags: compatibilityFlags as string[],
      durableObjects: doBindings(readWranglerConfig(root)),
      version,
    }),
  );
  writeFileSync(join(mainDir, EMAIL_INTERNAL_MODULE), EMAIL_INTERNAL_SOURCE);

  for (const name of ["entrypoint.sh", "env-allowlist.txt"]) {
    const source = join(root, "container", name);
    if (existsSync(source)) {
      copyFileSync(source, join(outDir, name));
    } else {
      console.log(`skipping ${name}: not present yet`);
    }
  }
}

// Only run when executed directly, so the generator stays importable in tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
