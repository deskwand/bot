import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Merges the maintainer-only release values (desktop/mygo.release.json) into
 * desktop/mygo.json so a local build carries the real update source. `restore`
 * puts the committed file back, so the real values never stay in the tree.
 *
 * A checkout without the release file builds against the committed
 * placeholders, which is what an open-source contributor gets.
 */
export function merge(root: string): "merged" | "skipped" {
  const configPath = join(root, "desktop/mygo.json");
  const backupPath = join(root, "desktop/mygo.json.orig");
  const releasePath = join(root, "desktop/mygo.release.json");
  if (!existsSync(releasePath)) return "skipped";

  copyFileSync(configPath, backupPath);
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { updates?: object };
  const release = JSON.parse(readFileSync(releasePath, "utf8")) as object;
  config.updates = { ...config.updates, ...release };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return "merged";
}

export function restore(root: string): "restored" | "nothing-to-restore" {
  const backupPath = join(root, "desktop/mygo.json.orig");
  if (!existsSync(backupPath)) return "nothing-to-restore";
  copyFileSync(backupPath, join(root, "desktop/mygo.json"));
  rmSync(backupPath);
  return "restored";
}

const command = process.argv[2];
if (command === "merge") {
  console.log(merge(process.cwd()));
} else if (command === "restore") {
  console.log(restore(process.cwd()));
} else {
  throw new Error("usage: mygo-release-config.ts merge|restore");
}
