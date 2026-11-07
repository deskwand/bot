/**
 * Preflight and post-publish checks for desktop client updates.
 *
 * Usage:
 *   node --experimental-strip-types scripts/desktop-release.ts preflight <version>
 *   node --experimental-strip-types scripts/desktop-release.ts check-remote <target> <version>
 *   node --experimental-strip-types scripts/desktop-release.ts verify <target> <version> <buildDir> [otherTarget]
 *
 * target 取 darwin-arm64 或 windows-amd64。The publish itself is performed by
 * `mygo build -upload`; this module only reads local files and the public
 * manifest. It never touches R2 or a signing key.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export const TARGETS = ["darwin-arm64", "windows-amd64"] as const;
export type Target = (typeof TARGETS)[number];

/** Parses a published target, rejecting everything else. */
export function parseTarget(value: string): Target {
  const target = TARGETS.find((candidate) => candidate === value);
  if (!target) throw new Error(`不支持的平台：${value}（支持 ${TARGETS.join("、")}）`);
  return target;
}

export const DEFAULT_UPDATE_BASE = "https://updates.example.com/bot";

/**
 * The part of the environment these helpers read. `NodeJS.ProcessEnv` is
 * assignable to it, and so is a plain literal from a test.
 */
export type ReleaseEnv = Readonly<Record<string, string | undefined>>;

/** The base URL the release files are served from, without a trailing slash. */
export function updateBase(env: ReleaseEnv = process.env): string {
  const raw = env.DESKWAND_UPDATE_BASE?.trim();
  return (raw || DEFAULT_UPDATE_BASE).replace(/\/+$/, "");
}

/** The update manifest of a target, e.g. update-windows-amd64.json. */
export function manifestUrl(target: Target, env: ReleaseEnv = process.env): string {
  return `${updateBase(env)}/update-${target}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compares two `x.y.z` versions. Throws for any other shape. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] => {
    const match = VERSION_PATTERN.exec(value);
    if (!match) throw new Error(`版本号必须为 x.y.z：${value}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index]!;
    const rightPart = right[index]!;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** Matches a `## 0.1.6`, `## [0.1.6]` or `## 0.1.6 - 2026-11-04` heading. */
export function changelogHasVersion(markdown: string, version: string): boolean {
  const escaped = escapeRegExp(version);
  const heading = new RegExp(`^##\\s+(?:\\[${escaped}\\]|${escaped})(?:\\s+-\\s+.*)?\\s*$`, "m");
  return heading.test(markdown);
}

/** Returns a description of the first version mismatch, or null when all agree. */
export function versionsInSync(v: { mygo: string; frontend: string; mainGo: string }): string | null {
  const mismatches: Array<[string, string]> = [
    ["desktop/frontend/package.json", v.frontend],
    ["desktop/main.go", v.mainGo],
  ];
  for (const [file, value] of mismatches) {
    if (value !== v.mygo) return `${file} ${value} ≠ desktop/mygo.json ${v.mygo}`;
  }
  return null;
}

/** Finds the single update archive of `version` and `target` in `dir`. */
export function findArchive(dir: string, version: string, target: Target): string {
  const suffix = `-${version}-${target}.tar.gz`;
  const matches = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => entry.name);

  if (matches.length !== 1) {
    throw new Error(
      `在 ${dir} 中找到 ${matches.length} 个 *${suffix}，需要恰好 1 个`,
    );
  }
  return join(dir, matches[0]!);
}

function cacheBusted(url: string, stamp: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}t=${stamp}`;
}

async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(`${label} 不是合法 JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} 不是 JSON 对象`);
  return parsed;
}

/**
 * Reads the public manifest. Only 404 counts as a first release; every other
 * failure must stop the publish so an old version is never overwritten.
 */
export async function checkPublishedVersion(
  manifestUrl: string,
  local: string,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<{ firstRelease: true } | { firstRelease: false; published: string }> {
  let response: Response;
  try {
    response = await fetchFn(cacheBusted(manifestUrl, now()));
  } catch (error) {
    throw new Error(`无法读取公网 manifest：${errorMessage(error)}`);
  }

  if (response.status === 404) return { firstRelease: true };
  if (response.status !== 200) {
    throw new Error(`读取公网 manifest 失败：HTTP ${response.status}`);
  }

  const manifest = await readJson(response, "公网 manifest");
  const published = manifest.version;
  if (typeof published !== "string" || published.length === 0) {
    throw new Error("公网 manifest 缺少 version");
  }

  let comparison: number;
  try {
    comparison = compareVersions(published, local);
  } catch {
    throw new Error(`无法比较版本：线上 ${published}，本地 ${local}`);
  }
  if (comparison === 0) {
    throw new Error(`线上版本已经是 ${published}，本地版本必须更高`);
  }
  if (comparison > 0) {
    throw new Error(`线上版本 ${published} 高于本地 ${local}，拒绝发布`);
  }
  return { firstRelease: false, published };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verifies the freshly published manifest and archive against the local
 * build. The manifest request carries `?t=<timestamp>` so a cached copy from
 * the CDN cannot mask a failed upload.
 */
export async function verifyPublished(options: {
  manifestUrl: string;
  version: string;
  localArchive: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;

  const localBytes = readFileSync(options.localArchive);
  const localHash = sha256Hex(localBytes);
  const localName = basename(options.localArchive);

  const manifestRequestUrl = cacheBusted(options.manifestUrl, now());
  let manifestResponse: Response;
  try {
    manifestResponse = await fetchFn(manifestRequestUrl);
  } catch (error) {
    throw new Error(`无法读取公网 manifest：${errorMessage(error)}`);
  }
  if (manifestResponse.status !== 200) {
    throw new Error(`公网 manifest 不可读：HTTP ${manifestResponse.status}`);
  }

  const manifest = await readJson(manifestResponse, "公网 manifest");
  const publishedVersion = manifest.version;
  if (typeof publishedVersion !== "string" || publishedVersion.length === 0) {
    throw new Error("公网 manifest 缺少 version");
  }
  if (publishedVersion !== options.version) {
    throw new Error(`公网 manifest 版本为 ${publishedVersion}，期望 ${options.version}`);
  }

  const size = manifest.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    throw new Error("公网 manifest 缺少有效的 size");
  }
  if (size !== localBytes.byteLength) {
    throw new Error(`manifest size ${size} 与本地归档 ${localBytes.byteLength} 不一致`);
  }

  const archiveUrl = manifest.url;
  if (typeof archiveUrl !== "string" || archiveUrl.length === 0) {
    throw new Error("公网 manifest 缺少有效的 url");
  }

  let remoteUrl: URL;
  try {
    remoteUrl = new URL(archiveUrl, options.manifestUrl);
  } catch {
    throw new Error(`公网 manifest 的 url 无效：${archiveUrl}`);
  }
  const remoteName = decodeURIComponent(remoteUrl.pathname.split("/").pop() ?? "");
  if (remoteName !== localName) {
    throw new Error(`manifest 归档文件名 ${remoteName} 与本地 ${localName} 不一致`);
  }

  let archiveResponse: Response;
  try {
    archiveResponse = await fetchFn(remoteUrl.href);
  } catch (error) {
    throw new Error(`无法下载公网归档：${errorMessage(error)}`);
  }
  if (archiveResponse.status !== 200) {
    throw new Error(`公网归档不可读：HTTP ${archiveResponse.status}`);
  }

  const archiveBytes = Buffer.from(await archiveResponse.arrayBuffer());
  if (archiveBytes.byteLength !== localBytes.byteLength) {
    throw new Error(
      `公网归档大小 ${archiveBytes.byteLength} 与本地 ${localBytes.byteLength} 不一致`,
    );
  }
  if (sha256Hex(archiveBytes) !== localHash) {
    throw new Error("公网归档的 SHA-256 与本地归档不一致");
  }
}

const SUMS_LINE = /^([0-9a-fA-F]{64})[ ]([ *])(.+)$/;

/** Parses MyGo's SHA256SUMS, which uses `<hex>  <name>` (or `sha256sum`'s ` *`). */
function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  const lines = text.split(/\r?\n/);

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const match = SUMS_LINE.exec(line);
    if (!match) throw new Error(`公网 SHA256SUMS 第 ${index + 1} 行格式异常：${line}`);

    const hash = match[1]!.toLowerCase();
    const name = match[3]!.replace(/^\.\//, "");
    if (sums.has(name)) throw new Error(`公网 SHA256SUMS 中 ${name} 出现重复行`);
    sums.set(name, hash);
  }

  if (sums.size === 0) throw new Error("公网 SHA256SUMS 为空");
  return sums;
}

/** The installer bundle and script that ship next to the auto-update archive. */
function installArtifacts(target: Target, version: string): string[] {
  return target === "darwin-arm64"
    ? [`deskwand-bot-${version}-arm64.dmg`, "install.sh"]
    : [`deskwand-bot-setup-${version}-amd64.exe`, "install.ps1"];
}

/**
 * Verifies the first-install artifacts of `target` against the public
 * `SHA256SUMS`, which MyGo writes to `desktop/build/SHA256SUMS` (the shared
 * parent of the per-target build directories). Every local file must be
 * listed with its own SHA-256 and must download byte-identical.
 *
 * `otherTarget` is only passed for the second job of a both-platform publish:
 * the shared checksum file must still carry the first platform's archive.
 */
export async function verifyPublishedAssets(options: {
  target: Target;
  version: string;
  buildDir: string;
  otherTarget?: Target;
  fetchFn?: typeof fetch;
  env?: ReleaseEnv;
  now?: () => number;
}): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const base = updateBase(env);
  const sumsUrl = `${base}/SHA256SUMS`;

  let sumsResponse: Response;
  try {
    sumsResponse = await fetchFn(cacheBusted(sumsUrl, now()));
  } catch (error) {
    throw new Error(`无法读取公网 SHA256SUMS：${errorMessage(error)}`);
  }
  if (sumsResponse.status !== 200) {
    throw new Error(`公网 SHA256SUMS 不可读：HTTP ${sumsResponse.status}`);
  }
  const sums = parseSha256Sums(await sumsResponse.text());

  const localArchive = findArchive(options.buildDir, options.version, options.target);
  const names = [basename(localArchive), ...installArtifacts(options.target, options.version)];

  for (const name of names) {
    let localBytes: Buffer;
    try {
      localBytes = readFileSync(join(options.buildDir, name));
    } catch {
      throw new Error(`本地缺少发布产物：${name}`);
    }

    const localHash = sha256Hex(localBytes);
    const listedHash = sums.get(name);
    if (listedHash === undefined) throw new Error(`公网 SHA256SUMS 缺少 ${name}`);
    if (listedHash !== localHash) {
      throw new Error(`公网 SHA256SUMS 中 ${name} 的校验和与本地不一致`);
    }

    const artifactUrl = `${base}/${name}`;
    let artifactResponse: Response;
    try {
      artifactResponse = await fetchFn(artifactUrl);
    } catch (error) {
      throw new Error(`无法下载公网 ${name}：${errorMessage(error)}`);
    }
    if (artifactResponse.status !== 200) {
      throw new Error(`公网 ${name} 不可读：HTTP ${artifactResponse.status}`);
    }

    const remoteBytes = Buffer.from(await artifactResponse.arrayBuffer());
    if (remoteBytes.byteLength !== localBytes.byteLength) {
      throw new Error(
        `公网 ${name} 大小 ${remoteBytes.byteLength} 与本地 ${localBytes.byteLength} 不一致`,
      );
    }
    if (sha256Hex(remoteBytes) !== localHash) {
      throw new Error(`公网 ${name} 的 SHA-256 与本地不一致`);
    }
  }

  if (options.otherTarget) {
    const otherArchive = `deskwand-bot-${options.version}-${options.otherTarget}.tar.gz`;
    if (!sums.has(otherArchive)) {
      throw new Error(`公网 SHA256SUMS 丢失另一平台归档 ${otherArchive}`);
    }
  }
}

function readJsonVersion(path: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`无法读取 ${path}`);
  }
  if (!isRecord(parsed) || typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`${path} 缺少 version`);
  }
  return parsed.version;
}

function preflight(version: string): void {
  const mygoPath = join(REPO_ROOT, "desktop", "mygo.json");
  const frontendPath = join(REPO_ROOT, "desktop", "frontend", "package.json");
  const mainGoPath = join(REPO_ROOT, "desktop", "main.go");
  const changelogPath = join(REPO_ROOT, "desktop", "CHANGELOG.md");

  const mygo = readJsonVersion(mygoPath);
  if (version !== mygo) {
    throw new Error(`参数版本 ${version} 与 desktop/mygo.json ${mygo} 不一致`);
  }

  const mainGo = readFileSync(mainGoPath, "utf8");
  const match = /const\s+appVersion\s*=\s*"([^"]+)"/.exec(mainGo);
  if (!match) throw new Error("无法从 desktop/main.go 读取 appVersion");

  const mismatch = versionsInSync({
    mygo,
    frontend: readJsonVersion(frontendPath),
    mainGo: match[1]!,
  });
  if (mismatch) throw new Error(`版本不一致：${mismatch}`);

  if (!changelogHasVersion(readFileSync(changelogPath, "utf8"), version)) {
    throw new Error(`desktop/CHANGELOG.md 缺少 ## ${version} 一节`);
  }
}

function needed(value: string | undefined, usage: string): string {
  if (!value) throw new Error(`缺少参数：${usage}`);
  return value;
}

const USAGE = "desktop-release.ts <preflight|check-remote|verify> ...";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "preflight": {
      const version = needed(args[0], "preflight <version>");
      preflight(version);
      console.log(`预检通过：${version}`);
      return;
    }
    case "check-remote": {
      const target = parseTarget(needed(args[0], "check-remote <target> <version>"));
      const version = needed(args[1], "check-remote <target> <version>");
      const result = await checkPublishedVersion(manifestUrl(target), version);
      if (result.firstRelease) {
        console.log(`${target} 首次发布：${version}`);
      } else {
        console.log(`${target} 线上版本 ${result.published}，准备发布 ${version}`);
      }
      return;
    }
    case "verify": {
      const target = parseTarget(needed(args[0], "verify <target> <version> <buildDir>"));
      const version = needed(args[1], "verify <target> <version> <buildDir>");
      const buildDir = needed(args[2], "verify <target> <version> <buildDir>");
      const otherTarget = args[3] === undefined ? undefined : parseTarget(args[3]);
      const localArchive = findArchive(buildDir, version, target);
      await verifyPublished({ manifestUrl: manifestUrl(target), version, localArchive });
      await verifyPublishedAssets({ target, version, buildDir, otherTarget });
      console.log(`${target} 核验通过：${version}`);
      return;
    }
    default:
      throw new Error(`用法：${USAGE}`);
  }
}

// Only run when executed directly, so helpers stay importable in tests.
//
// The comparison resolves both paths first: on macOS /tmp is a symlink to
// /private/tmp, so a plain string compare of `import.meta.url` against
// `pathToFileURL(argv[1])` says "imported" and main() never runs — the process
// still exits 0, which silently skips preflight, the remote version check and
// the post-upload verification.
export function isEntryPoint(
  argv1: string | undefined,
  moduleUrl: string,
  realpath: (path: string) => string = realpathSync,
): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpath(argv1) === realpath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}
