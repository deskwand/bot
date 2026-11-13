import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const entrypoint = join(repoRoot, "container", "entrypoint.sh");
const allowlist = join(repoRoot, "container", "env-allowlist.txt");

const TEMPLATE = `listen = "@@LISTEN@@"
data = "@@DATA_DIR@@"
# @@ENV_BINDINGS@@
`;

let root = "";
let appDir = "";
let dataDir = "";
let stub = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskwand-entrypoint-"));
  appDir = join(root, "app");
  dataDir = join(root, "data");
  mkdirSync(appDir);
  mkdirSync(dataDir);
  writeFileSync(join(appDir, "config.capnp.template"), TEMPLATE);
  copyFileSync(allowlist, join(appDir, "env-allowlist.txt"));
  stub = join(root, "workerd-stub.sh");
  writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$*"\n');
  chmodSync(stub, 0o755);
});

afterEach(() => {
  chmodSync(dataDir, 0o755);
  rmSync(root, { recursive: true, force: true });
});

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  config: string;
};

function run(
  extra: Record<string, string> = {},
  cleared: string[] = [],
): RunResult {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    APP_DIR: appDir,
    DATA_DIR: dataDir,
    LISTEN: "127.0.0.1:8799",
    WORKERD_BIN: stub,
    DESKWAND_CONFIG: '{"a":"b"}',
    ADMIN_TOKEN: "t",
    MODEL_KEY_X: "k",
    ...extra,
  };
  for (const name of cleared) delete env[name];

  // `PUBLIC_BASE_URL` stays unset on purpose so the script's default is
  // exercised; the generated Worker types declare it required on ProcessEnv.
  const result = spawnSync("sh", [entrypoint], {
    env: env as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  let config = "";
  try {
    config = readFileSync(join(appDir, "config.capnp"), "utf8");
  } catch {
    // The script may exit before writing the config.
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    config,
  };
}

describe("container entrypoint", () => {
  it("emits a binding for each allowlisted variable", () => {
    const result = run();

    expect(result.status).toBe(0);
    for (const name of [
      "DESKWAND_CONFIG",
      "ADMIN_TOKEN",
      "MODEL_KEY_X",
      "PUBLIC_BASE_URL",
    ]) {
      expect(result.config).toContain(
        `(name = "${name}", fromEnvironment = "${name}"),`,
      );
    }
    expect(result.config).not.toContain("@@");
  });

  it("ignores variables outside the allowlist", () => {
    const result = run({ HOME: "/tmp/home", SOMETHING_ELSE: "1" });

    expect(result.status).toBe(0);
    expect(result.config).not.toContain("HOME");
    expect(result.config).not.toContain("SOMETHING_ELSE");
  });

  it("never writes a value into the config", () => {
    const payload = '{"a":"b","quote":"\\"","home":"$HOME","tick":"`id`"}';
    const result = run({
      DESKWAND_CONFIG: payload,
      ADMIN_TOKEN: "s3cr3t-VALUE",
    });

    expect(result.status).toBe(0);
    for (const text of [result.config, result.stdout, result.stderr]) {
      expect(text).not.toContain("s3cr3t-VALUE");
      expect(text).not.toContain(payload);
    }
  });

  it("skips a malformed name with a warning", () => {
    const result = run({ "MODEL_KEY_bad-name": "1" });

    expect(result.status).toBe(0);
    expect(result.config).not.toContain("MODEL_KEY_bad-name");
    expect(result.stderr).toContain("MODEL_KEY_bad-name");
  });

  it("treats an empty model key as unset", () => {
    const result = run({ MODEL_KEY_X: "" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MODEL_KEY_");
    expect(result.stdout).not.toContain("serve ");
  });

  it("skips an empty allowlisted variable", () => {
    const result = run({ TELEGRAM_BOT_TOKEN: "" });

    expect(result.status).toBe(0);
    expect(result.config).not.toContain(
      '(name = "TELEGRAM_BOT_TOKEN", fromEnvironment = "TELEGRAM_BOT_TOKEN")',
    );
  });

  it("rejects a quote in LISTEN", () => {
    const result = run({ LISTEN: '127.0.0.1:8799"' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LISTEN");
    expect(result.stdout).not.toContain("serve ");
  });

  it("rejects a quote in DATA_DIR", () => {
    const result = run({ DATA_DIR: `${dataDir}"` });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DATA_DIR");
    expect(result.stdout).not.toContain("serve ");
  });

  it("substitutes the listen address and data directory", () => {
    const result = run({ LISTEN: "127.0.0.1:9123" });

    expect(result.config).toContain("127.0.0.1:9123");
    expect(result.config).toContain(dataDir);
  });

  it("fails when DESKWAND_CONFIG is missing", () => {
    const result = run({}, ["DESKWAND_CONFIG"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DESKWAND_CONFIG");
    expect(result.stdout).not.toContain("serve ");
  });

  it("fails when ADMIN_TOKEN is missing", () => {
    const result = run({}, ["ADMIN_TOKEN"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ADMIN_TOKEN");
    expect(result.stdout).not.toContain("serve ");
  });

  it("fails when no model key is set", () => {
    const result = run({}, ["MODEL_KEY_X"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MODEL_KEY_");
    expect(result.stdout).not.toContain("serve ");
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails before starting when the data directory is not writable",
    () => {
      chmodSync(dataDir, 0o555);

      const result = run();

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(dataDir);
      expect(result.stdout).not.toContain("serve ");
    },
  );

  it("execs workerd serve with the generated config", () => {
    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`serve ${join(appDir, "config.capnp")}`);
  });
});
