import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findHanLiterals } from "../scripts/check-i18n";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "check-i18n-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SCRIPT = resolve(process.cwd(), "scripts/check-i18n.ts");

function runCli(cwd: string, args: string[] = []) {
  return spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("findHanLiterals", () => {
  it("reports Chinese in string literals and skips comments", () => {
    expect(findHanLiterals('const a = "中文";\n// 注释中文\n', "ts")).toEqual([
      { line: 1, text: "中文" },
    ]);
  });

  it("reports Chinese in JSX text nodes", () => {
    const hits = findHanLiterals("<p>你好</p>", "ts");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(1);
  });

  it("reports Chinese in Go strings and raw strings, skipping block comments", () => {
    expect(findHanLiterals('x := "ok"\n/* 中文 */\ny := `模板`', "go")).toEqual([
      { line: 3, text: "模板" },
    ]);
  });

  it("does not treat comment markers inside strings as comments", () => {
    expect(findHanLiterals('const a = "http://例子"; // 注释', "ts")).toEqual([
      { line: 1, text: "http://例子" },
    ]);
  });
});

describe("check-i18n CLI", () => {
  it("reports hits and exits zero without --enforce", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "foo.ts"), 'export const greeting = "中文";\n');

    const result = runCli(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("src/foo.ts:1:");
  });

  it("exits one when a hit falls under --enforce", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "foo.ts"), 'export const greeting = "中文";\n');

    const result = runCli(dir, ["--enforce", "src/**"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("src/foo.ts:1:");
  });
});
