/**
 * Signs the exact bytes of `dist/worker-release/manifest.json`.
 *
 * Usage (prefer the key-file route; it keeps the PEM out of shell history and
 * the process environment):
 *   DESKWAND_RELEASE_SIGNING_KEY_FILE=/secure/release-key.pem npm run release:sign
 *
 * The inline form is supported for CI secret stores only:
 *   DESKWAND_RELEASE_SIGNING_KEY="$(cat /secure/release-key.pem)" npm run release:sign
 *
 * The Ed25519 private key is never embedded or committed. The script refuses
 * to run without a key and writes only the detached base64 signature.
 */
import { createPrivateKey, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Loads an Ed25519 private key from env PEM or a PEM file path. */
export function loadSigningKey(env: Record<string, string | undefined> = process.env): KeyObject {
  const inline = env.DESKWAND_RELEASE_SIGNING_KEY;
  const keyFile = env.DESKWAND_RELEASE_SIGNING_KEY_FILE;
  if (!inline && !keyFile) {
    throw new Error(
      "缺少发布签名私钥：设置 DESKWAND_RELEASE_SIGNING_KEY（PEM）或 DESKWAND_RELEASE_SIGNING_KEY_FILE",
    );
  }

  let pem: string;
  if (inline) {
    // Accept PEM passed through environments that escape newlines.
    pem = inline.includes("\\n") && !inline.includes("\n") ? inline.replaceAll("\\n", "\n") : inline;
  } else {
    try {
      pem = readFileSync(keyFile as string, "utf8");
    } catch {
      throw new Error(`无法读取发布签名私钥文件：${String(keyFile)}`);
    }
  }

  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error("发布签名私钥不是有效的 PEM Ed25519 私钥");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`发布签名密钥类型为 ${String(key.asymmetricKeyType)}，必须是 ed25519`);
  }
  return key;
}

/** Signs the raw manifest bytes and returns a detached base64 signature. */
export function signManifest(manifestBytes: Uint8Array, privateKey: KeyObject): string {
  return sign(null, Buffer.from(manifestBytes), privateKey).toString("base64");
}

/** Verifies a detached base64 (or raw) signature. Used by tests and tooling. */
export function verifyManifestSignature(
  manifestBytes: Uint8Array,
  signature: string | Uint8Array,
  publicKey: KeyObject,
): boolean {
  const signatureBytes = typeof signature === "string"
    ? Buffer.from(signature.trim(), "base64")
    : Buffer.from(signature);
  return verify(null, Buffer.from(manifestBytes), publicKey, signatureBytes);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function argument(name: string, argv: string[]): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const manifestPath = resolve(
    argument("manifest", argv) ?? "dist/worker-release/manifest.json",
  );
  const signaturePath = resolve(
    argument("signature", argv) ?? manifestPath.replace(/manifest\.json$/, "manifest.sig"),
  );

  let manifestBytes: Buffer;
  try {
    manifestBytes = readFileSync(manifestPath);
  } catch {
    fail(`找不到待签名 manifest：${manifestPath}（先运行 npm run release:worker）`);
  }

  const key = loadSigningKey();
  const signature = signManifest(manifestBytes, key);
  writeFileSync(signaturePath, `${signature}\n`);

  console.log("Worker release manifest signed");
  console.log(`  manifest:  ${manifestPath}`);
  console.log(`  signature: ${signaturePath}`);
  console.log("  key type:  ed25519");
}

// Only run when executed directly, so helpers stay importable in tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
