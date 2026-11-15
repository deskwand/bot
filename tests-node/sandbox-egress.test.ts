import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandboxd, type Sandboxd } from "../container/sandbox/server";
import { renderTemplate } from "../scripts/build-container";

const repoRoot = resolve(import.meta.dirname, "..");
const TOKEN = "egress-token";

/**
 * The generated config embeds module files and needs POSIX `sh` to run the
 * entrypoint. Windows CI has neither reliably, and the real container path is
 * covered by container.yml on Linux.
 */
const skip = it.skipIf(process.platform === "win32");

function workerdBinary(): string {
  const manifest = createRequire(import.meta.url).resolve("workerd/package.json");
  return join(dirname(manifest), "bin", "workerd");
}

function freePort(): Promise<number> {
  // The port is released before workerd binds it. A same-host race is possible
  // but vanishingly rare on loopback; a retry here would hide a real failure.
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitFor(port: number, path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
      if (response.status > 0) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`workerd did not come up: ${last}\n${log}`);
}

/**
 * A worker that reaches the sandbox twice: once through the binding the
 * entrypoint declares, once through global fetch.
 */
const MAIN_MODULE = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = "http://127.0.0.1:" + url.searchParams.get("port") + "/healthz";
    const headers = { authorization: "Bearer " + url.searchParams.get("token") };
    try {
      const response = url.searchParams.get("via") === "binding"
        ? await env.SANDBOX.fetch(target, { headers })
        : await fetch(target, { headers });
      return new Response(response.status + " " + (await response.text()));
    } catch (error) {
      return new Response("ERROR " + String(error && error.message));
    }
  },
};
`;

const FRONT_MODULE = `
export default {
  fetch(request, env) {
    return env.MAIN.fetch(request);
  },
};
`;

const STORE_MODULE = `export default { fetch() { return new Response("store"); } };\n`;

let root = "";
let appDir = "";
let dataDir = "";
let daemon: Sandboxd | null = null;
let child: ChildProcess | null = null;
let origin = "";
/** workerd logs the refusal; the JS error itself is an opaque "internal error". */
let log = "";

beforeAll(async () => {
  if (process.platform === "win32") return;
  root = mkdtempSync(join(tmpdir(), "deskwand-egress-"));
  appDir = join(root, "app");
  dataDir = join(root, "data");
  for (const dir of [appDir, dataDir, join(appDir, "main"), join(appDir, "front"), join(appDir, "store")]) {
    mkdirSync(dir, { recursive: true });
  }
  const modules: [string, string][] = [
    [join(appDir, "main", "index.js"), MAIN_MODULE],
    [join(appDir, "main", "email-internal.js"), "export default {};\n"],
    [join(appDir, "front", "index.js"), FRONT_MODULE],
    [join(appDir, "store", "index.js"), STORE_MODULE],
  ];
  for (const [path, body] of modules) writeFileSync(path, body);
  writeFileSync(
    join(appDir, "config.capnp.template"),
    renderTemplate({
      modules: [{ name: "index.js", type: "esModule" }],
      compatibilityDate: "2026-11-01",
      compatibilityFlags: [],
      durableObjects: [],
      version: "egress-test",
    }),
  );
  copyFileSync(
    join(repoRoot, "container", "env-allowlist.txt"),
    join(appDir, "env-allowlist.txt"),
  );

  daemon = await startSandboxd(
    {
      token: TOKEN,
      sandboxDir: join(root, "sandbox"),
      version: "test",
      diskLimitBytes: 1024 * 1024 * 1024,
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 60_000,
    },
    0,
  );

  const port = await freePort();
  origin = `http://127.0.0.1:${String(port)}`;
  child = spawn("sh", [join(repoRoot, "container", "entrypoint.sh")], {
    env: {
      ...process.env,
      APP_DIR: appDir,
      DATA_DIR: dataDir,
      LISTEN: `127.0.0.1:${String(port)}`,
      WORKERD_BIN: workerdBinary(),
      DESKWAND_CONFIG: "{}",
      ADMIN_TOKEN: "admin",
      MODEL_KEY_X: "key",
      // The whole point: a private host:port, which global fetch refuses.
      SANDBOX_URL: `http://127.0.0.1:${String(daemon.port)}`,
      SANDBOX_TOKEN: TOKEN,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  await waitFor(port, "/");
}, 60_000);

afterAll(async () => {
  child?.kill("SIGKILL");
  await daemon?.close();
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("sandbox egress", () => {
  skip("reaches the sandbox through the declared binding", async () => {
    const query = new URLSearchParams({
      port: String(daemon?.port),
      token: TOKEN,
      via: "binding",
    });
    const response = await fetch(`${origin}/?${query.toString()}`);

    expect(await response.text()).toMatch(/^200 .*"protocol":1/);
  });

  skip("keeps public-only egress in the generated config", async () => {
    const config = readFileSync(join(appDir, "config.capnp"), "utf8");

    expect(config).toContain('network = (allow = ["public"]');
    expect(config).toContain('service = "sandbox"');
  });

  skip("global fetch to the same private address is still refused", async () => {
    const query = new URLSearchParams({
      port: String(daemon?.port),
      token: TOKEN,
      via: "global",
    });
    const mark = log.length;
    const body = await (await fetch(`${origin}/?${query.toString()}`)).text();

    expect(body).not.toMatch(/^200/);
    const deadline = Date.now() + 2_000;
    while (!log.slice(mark).includes("is not allowed") && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(log.slice(mark)).toContain("is not allowed");
  });
});
