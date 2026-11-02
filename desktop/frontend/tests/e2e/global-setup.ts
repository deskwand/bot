import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Build once so the production-bundle assertion scans the real output.
export default function globalSetup() {
  const cwd = fileURLToPath(new URL("../..", import.meta.url));
  execFileSync("npm", ["run", "build"], { cwd, stdio: "inherit" });
}
