/**
 * Generates the Ed25519 release signing key pair used to sign Worker release
 * manifests.
 *
 * Usage:
 *   npm run generate:release-key
 *
 * The private key is written to $HOME/.deskwand-bot/release-signing-key.pem with
 * mode 0600 (or to DESKWAND_RELEASE_SIGNING_KEY_FILE). The public key is
 * written to desktop/internal/release/keys/deskwand-release-1.pub.pem and is
 * safe to commit. Both files are created exclusively: an existing file makes
 * the command fail rather than overwrite a key.
 *
 * Never commit the private key and never reuse a development key for a public
 * release.
 */
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE_KEY_ID = "deskwand-release-1";
export const PRODUCTION_PUBLIC_KEY_PATH = join(
  "desktop",
  "internal",
  "release",
  "keys",
  "deskwand-release-1.pub.pem",
);

export function defaultPrivateKeyPath(env: Record<string, string | undefined> = process.env): string {
  return env.DESKWAND_RELEASE_SIGNING_KEY_FILE ?? join(homedir(), ".deskwand-bot", "release-signing-key.pem");
}

export type GeneratedKeyPaths = {
  privateKeyPath: string;
  publicKeyPath: string;
};

/** Generates and persists a new Ed25519 key pair. Never overwrites a file. */
export function generateReleaseKey(
  repoRoot: string,
  privateKeyPath = defaultPrivateKeyPath(),
): GeneratedKeyPaths {
  const publicKeyPath = resolve(repoRoot, PRODUCTION_PUBLIC_KEY_PATH);
  for (const existing of [privateKeyPath, publicKeyPath]) {
    if (existsSync(existing)) {
      throw new Error(`拒绝覆盖已有密钥文件：${existing}`);
    }
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  mkdirSync(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(publicKeyPath), { recursive: true });

  writeFileSync(privateKeyPath, privatePem, { mode: 0o600, flag: "wx" });
  chmodSync(privateKeyPath, 0o600);
  writeFileSync(publicKeyPath, publicPem, { flag: "wx" });

  return { privateKeyPath, publicKeyPath };
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const paths = generateReleaseKey(repoRoot);
  console.log("Release key generated");
  console.log(`  keyId:      ${RELEASE_KEY_ID}`);
  console.log(`  private:    ${paths.privateKeyPath} (mode 0600, never commit)`);
  console.log(`  public:     ${paths.publicKeyPath}`);
  console.log("Sign releases with: npm run release:sign (DESKWAND_RELEASE_SIGNING_KEY_FILE)");
}

// Only run when executed directly, so helpers stay importable in tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
