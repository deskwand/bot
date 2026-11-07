import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLACEHOLDERS: Record<string, string | undefined> = {
  "https://your-worker.workers.dev": process.env.PUBLIC_BASE_URL,
  "my-artifacts": process.env.R2_ARTIFACTS_BUCKET,
};

/**
 * Writes wrangler.local.jsonc: the committed config with the maintainer's real
 * values filled in. The committed file only holds placeholders, so the bucket
 * name and the public URL never reach the public repository.
 */
export function writeLocalConfig(
  root: string,
  env: Record<string, string | undefined> = PLACEHOLDERS,
): string {
  const source = join(root, "wrangler.jsonc");
  let text = readFileSync(source, "utf8");
  for (const [placeholder, value] of Object.entries(env)) {
    if (!value) throw new Error(`missing value for placeholder ${placeholder}`);
    text = text.split(placeholder).join(value);
  }
  const target = join(root, "wrangler.local.jsonc");
  writeFileSync(target, text);
  return target;
}

// Guarded so importing this module from a test never writes a file.
if (process.argv[1]?.endsWith("wrangler-release-config.ts")) {
  writeLocalConfig(process.cwd());
}
