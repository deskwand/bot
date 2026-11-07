import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function tracked(glob: string): string[] {
  return execFileSync("git", ["ls-files", glob], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.length > 0);
}

/** Runs git grep, treating "no match" (exit 1) as an empty result. */
function grepTracked(pattern: string): string {
  try {
    return execFileSync("git", ["grep", "-lI", pattern, "--", "."], { encoding: "utf8" });
  } catch (error) {
    const code = (error as { status?: number }).status;
    if (code !== 1) throw error;
    return "";
  }
}

describe("repository hygiene", () => {
  it("keeps internal docs out of git", () => {
    for (const prefix of ["docs/superpowers/", "docs/notes/", "docs/verification/"]) {
      expect(tracked(`${prefix}*`)).toEqual([]);
    }
  });

  // 这里的标识符故意拼着写：若直接写字面量，这个文件自己就会成为命中项，
  // 这条断言永远红。
  const NEEDLES = [
    `zouji${'chun'}`,
    `9dbf${'904e'}`,
    `om${'agt'}`,
    `bot-${'artifacts'}`,
    `file.deskwand${'.com'}`,
    `api.deskwand${'.com'}`,
  ];

  it("carries no maintainer identifiers", () => {
    for (const needle of NEEDLES) {
      expect(grepTracked(needle)).toBe("");
    }
  });

  it("ships the preset skill package", () => {
    expect(tracked("skills/*/*")).toContain("skills/brainstorming/SKILL.md");
  });
});
