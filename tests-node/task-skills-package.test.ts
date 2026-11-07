import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkill } from "../src/skills/catalog";

// The packaged skill is what a deployer imports into R2; check the real file
// rather than a copy, so a broken entry cannot ship unnoticed.
const source = readFileSync(
  join(process.cwd(), "skills/brainstorming/SKILL.md"),
  "utf8",
);

describe("packaged brainstorming skill", () => {
  it("parses as an importable entry", () => {
    expect(parseSkill("brainstorming", source)).toMatchObject({
      name: "brainstorming",
      path: "/skills/brainstorming/SKILL.md",
    });
  });

  it("fits a phone conversation", () => {
    expect(source).toContain("一次只问一个");
    expect(source).toContain("save_artifact");
  });

  it("carries no runner, script or sub-skill the sandbox cannot provide", () => {
    expect(source).not.toMatch(
      /REQUIRED SUB-SKILL|--open|visual-companion\.md|`git |`bash|`node /,
    );
  });
});
