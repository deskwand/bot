/**
 * Generates the Ed25519 release signing key pair used to sign Worker release
 * manifests.
 *
 * Usage:
 *   npm run generate:release-key              # Worker release key
 *   npm run generate:release-key -- --client  # desktop client update key
 *
 * The Worker release private key is written to
 * $HOME/.deskwand-bot/release-signing-key.pem with mode 0600 (or to
 * DESKWAND_RELEASE_SIGNING_KEY_FILE). Its public key is written to
 * desktop/internal/release/keys/deskwand-release-1.pub.pem.
 *
 * The client update private key (--client) is written to
 * $HOME/.deskwand-bot/client-update-key.pem with mode 0600. MyGo signs and
 * verifies desktop updates with the public key configured in mygo.json's
 * updates.publicKey, so the command prints that public key for the maintainer
 * to paste into the configuration instead of writing an unused file.
 *
 * Both files are created exclusively: an existing file makes the command fail
 * rather than overwrite a key. The two key pairs are deliberately separate;
 * never sign a Worker release with the client update key or the reverse.
 *
 * Never commit a private key and never reuse a development key for a public
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

export const CLIENT_UPDATE_KEY_ID = "deskwand-client-1";

export function defaultPrivateKeyPath(env: Record<string, string | undefined> = process.env): string {
  return env.DESKWAND_RELEASE_SIGNING_KEY_FILE ?? join(homedir(), ".deskwand-bot", "release-signing-key.pem");
}

export function defaultClientPrivateKeyPath(): string {
  return join(homedir(), ".deskwand-bot", "client-update-key.pem");
}

export type GeneratedKeyPaths = {
  privateKeyPath: string;
  publicKeyPath: string;
  publicKeyPem?: string;
};

function generateKey(
  repoRoot: string,
  privateKeyPath: string,
  publicKeyPathRelative: string | null,
): GeneratedKeyPaths {
  const publicKeyPath = publicKeyPathRelative ? resolve(repoRoot, publicKeyPathRelative) : "";
  for (const existing of [privateKeyPath, publicKeyPath].filter(Boolean)) {
    if (existsSync(existing)) {
      throw new Error(`拒绝覆盖已有密钥文件：${existing}`);
    }
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  mkdirSync(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  writeFileSync(privateKeyPath, privatePem, { mode: 0o600, flag: "wx" });
  chmodSync(privateKeyPath, 0o600);
  if (publicKeyPath) {
    mkdirSync(dirname(publicKeyPath), { recursive: true });
    writeFileSync(publicKeyPath, publicPem, { flag: "wx" });
  }

  return { privateKeyPath, publicKeyPath, publicKeyPem: publicPem };
}

/** Generates and persists the Worker release key pair. Never overwrites a file. */
export function generateReleaseKey(
  repoRoot: string,
  privateKeyPath = defaultPrivateKeyPath(),
): GeneratedKeyPaths {
  return generateKey(repoRoot, privateKeyPath, PRODUCTION_PUBLIC_KEY_PATH);
}

/**
 * Generates the desktop client update key. Only the private key is written;
 * the public key is returned for mygo.json's updates.publicKey.
 */
export function generateClientUpdateKey(
  repoRoot: string,
  privateKeyPath = defaultClientPrivateKeyPath(),
): GeneratedKeyPaths {
  return generateKey(repoRoot, privateKeyPath, null);
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const client = process.argv.slice(2).includes("--client");
  const paths = client ? generateClientUpdateKey(repoRoot) : generateReleaseKey(repoRoot);
  console.log(client ? "Client update key generated" : "Release key generated");
  console.log(`  keyId:      ${client ? CLIENT_UPDATE_KEY_ID : RELEASE_KEY_ID}`);
  console.log(`  private:    ${paths.privateKeyPath} (mode 0600, never commit)`);
  if (client) {
    console.log("  Updates.publicKey for desktop/mygo.json (safe to commit):");
    console.log("");
    console.log(paths.publicKeyPem?.trimEnd());
    console.log("");
    console.log("Set updates.url, then sign client builds with MYGO_UPDATER_PRIVATE_KEY.");
    console.log("Never commit the private key.");
  } else {
    console.log(`  public:     ${paths.publicKeyPath}`);
    console.log("Sign releases with: npm run release:sign (DESKWAND_RELEASE_SIGNING_KEY_FILE)");
  }
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
