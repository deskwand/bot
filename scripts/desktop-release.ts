/**
 * Preflight and post-publish checks for desktop client updates.
 *
 * Usage:
 *   node --experimental-strip-types scripts/desktop-release.ts preflight <version>
 *   node --experimental-strip-types scripts/desktop-release.ts check-remote <manifestUrl> <version>
 *   node --experimental-strip-types scripts/desktop-release.ts verify <manifestUrl> <version> <buildDir>
 *
 * The publish itself is performed by `mygo build -upload`; this module only
 * reads local files and the public manifest. It never touches R2 or a signing
 * key.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

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

/** Finds the single update archive for `version` in `dir`. */
export function findArchive(dir: string, version: string): string {
  const suffix = `-${version}-darwin-arm64.tar.gz`;
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
): Promise<{ firstRelease: true } | { firstRelease: false; published: string }> {
  let response: Response;
  try {
    response = await fetchFn(manifestUrl);
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
      const manifestUrl = needed(args[0], "check-remote <manifestUrl> <version>");
      const version = needed(args[1], "check-remote <manifestUrl> <version>");
      const result = await checkPublishedVersion(manifestUrl, version);
      if (result.firstRelease) {
        console.log(`首次发布：${version}`);
      } else {
        console.log(`线上版本 ${result.published}，准备发布 ${version}`);
      }
      return;
    }
    case "verify": {
      const manifestUrl = needed(args[0], "verify <manifestUrl> <version> <buildDir>");
      const version = needed(args[1], "verify <manifestUrl> <version> <buildDir>");
      const buildDir = needed(args[2], "verify <manifestUrl> <version> <buildDir>");
      const localArchive = findArchive(buildDir, version);
      await verifyPublished({ manifestUrl, version, localArchive });
      console.log(`核验通过：${version}`);
      return;
    }
    default:
      throw new Error(`用法：${USAGE}`);
  }
}

// Only run when executed directly, so helpers stay importable in tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}
