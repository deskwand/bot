import { mkdirSync } from "node:fs";
import { parseDiskLimitMb, startSandboxd } from "./server.js";

const token = process.env.SANDBOX_TOKEN ?? "";
if (token === "") {
  // Fail closed: an executor without authentication is worse than no executor.
  // Exit 0 so `restart: on-failure` leaves it stopped instead of crash-looping
  // on every deployment that does not want a sandbox.
  console.error("sandboxd: SANDBOX_TOKEN is empty; sandbox disabled");
  process.exit(0);
}

const port = Number.parseInt(process.env.SANDBOX_PORT ?? "8080", 10);
const sandboxDir = process.env.SANDBOX_DIR ?? "/sandbox";
// The working directory of every command; a missing one would fail every exec.
mkdirSync(sandboxDir, { recursive: true });

const diskLimitBytes = parseDiskLimitMb(process.env.SANDBOX_DISK_MB);

const daemon = await startSandboxd(
  {
    token,
    sandboxDir,
    version: process.env.SANDBOX_VERSION ?? "dev",
    diskLimitBytes,
    defaultTimeoutMs: 600_000,
    maxTimeoutMs: 3_600_000,
  },
  port,
);

console.log(`sandboxd listening on ${String(daemon.port)}`);
