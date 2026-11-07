import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverSkills, parseSkill } from "../../src/skills/catalog";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

beforeEach(async () => {
  const page = await env.ARTIFACTS.list({ prefix: "skills/" });
  const keys = page.objects.map((object) => object.key);
  if (keys.length > 0) await env.ARTIFACTS.delete(keys);
});

function body(name: string, description = "Discuss ideas"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nSECRET_BODY`;
}

describe("parseSkill", () => {
  it("returns the metadata without the body", () => {
    expect(parseSkill("demo", body("demo"))).toEqual({
      name: "demo",
      description: "Discuss ideas",
      path: "/skills/demo/SKILL.md",
    });
  });

  it("accepts quoted and folded descriptions", () => {
    expect(
      parseSkill(
        "demo",
        '---\nname: demo\ndescription: "quoted: #not-a-comment"\n---\nbody',
      ),
    ).toMatchObject({ description: "quoted: #not-a-comment" });

    expect(
      parseSkill(
        "demo",
        "---\nname: demo\ndescription: >-\n  one\n  two\n---\nbody",
      ),
    ).toMatchObject({ description: "one two" });
  });

  it("ignores unknown metadata and a BOM or CRLF line endings", () => {
    expect(
      parseSkill(
        "demo",
        "\uFEFF---\r\nname: demo\r\ndescription: demo skill\r\nlicense: MIT\r\n---\r\nbody",
      ),
    ).toMatchObject({ name: "demo", description: "demo skill" });
  });

  it("rejects what cannot become an entry", () => {
    const cases: [string, string][] = [
      ["demo", "no front matter at all"],
      ["demo", "---\nname: demo\n---\nbody"],
      ["demo", "---\ndescription: demo\n---\nbody"],
      ["demo", "---\nname: other\ndescription: demo\n---\nbody"],
      ["demo", "---\nname: demo\ndescription: 42\n---\nbody"],
      ["demo", "---\nname: demo\ndescription: '   '\n---\nbody"],
      ["demo", `---\nname: demo\ndescription: ${"x".repeat(1025)}\n---\nbody`],
      ["demo", "---\nname: demo\ndescription: demo\nname: demo\n---\nbody"],
      ["demo", "---\nname: demo\ndescription: demo\nbroken: [\n---\nbody"],
      ["Bad", body("Bad")],
      ["-a", body("-a")],
    ];
    for (const [name, content] of cases) {
      expect(typeof parseSkill(name, content)).toBe("string");
    }
  });

  it("refuses aliases so a small file cannot expand into a large tree", () => {
    const content =
      "---\nname: demo\ndescription: &d demo\ncopy: *d\n---\nbody";
    expect(typeof parseSkill("demo", content)).toBe("string");
  });
});

describe("discoverSkills", () => {
  it("lists entries sorted by name and never reads the body into the catalog", async () => {
    await env.ARTIFACTS.put("skills/zeta/SKILL.md", body("zeta"));
    await env.ARTIFACTS.put("skills/alpha/SKILL.md", body("alpha"));
    await env.ARTIFACTS.put("skills/alpha/references/x.md", "reference");
    await env.ARTIFACTS.put("skills/uninstalled/references/x.md", "reference");
    await env.ARTIFACTS.put("work/t1/private.md", "private");

    const catalog = await discoverSkills(env.ARTIFACTS);

    expect(catalog.skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"]);
    expect(catalog.skills[0]?.path).toBe("/skills/alpha/SKILL.md");
    expect(JSON.stringify(catalog)).not.toContain("SECRET_BODY");
    expect(catalog.diagnostics).toEqual([]);
  });

  it("returns an empty catalog for an empty or missing library", async () => {
    expect(await discoverSkills(env.ARTIFACTS)).toEqual({
      skills: [],
      diagnostics: [],
    });
  });

  it("keeps good skills and reports broken entries", async () => {
    await env.ARTIFACTS.put("skills/good/SKILL.md", body("good"));
    await env.ARTIFACTS.put("skills/broken/SKILL.md", "no front matter");
    await env.ARTIFACTS.put("skills/mismatch/SKILL.md", body("other"));

    const catalog = await discoverSkills(env.ARTIFACTS);

    expect(catalog.skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(catalog.diagnostics).toHaveLength(2);
    expect(catalog.diagnostics.join("\n")).toContain("skills/broken/SKILL.md");
    expect(catalog.diagnostics.join("\n")).toContain("skills/mismatch/SKILL.md");
  });

  it("ignores nested directories and stray files", async () => {
    await env.ARTIFACTS.put("skills/demo/nested/SKILL.md", body("nested"));
    await env.ARTIFACTS.put("skills/README.md", "library notes");

    expect(await discoverSkills(env.ARTIFACTS)).toEqual({
      skills: [],
      diagnostics: [],
    });
  });

  it("walks every list page", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [{ key: "skills/zeta/references/x.md", size: 3 }],
        truncated: true,
        cursor: "next",
      })
      .mockResolvedValueOnce({
        objects: [{ key: "skills/zeta/SKILL.md", size: 60 }],
        truncated: false,
      });
    const get = vi.fn().mockResolvedValue({
      size: 60,
      text: async () => body("zeta"),
    });

    const catalog = await discoverSkills({
      list,
      get,
    } as unknown as R2Bucket);

    expect(catalog.skills.map((skill) => skill.name)).toEqual(["zeta"]);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ cursor: "next" });
  });

  it("rejects a file the listing reports as too large without reading it", async () => {
    const get = vi.fn();
    const catalog = await discoverSkills({
      list: vi.fn().mockResolvedValue({
        objects: [{ key: "skills/big/SKILL.md", size: (1 << 20) + 1 }],
        truncated: false,
      }),
      get,
    } as unknown as R2Bucket);

    expect(get).not.toHaveBeenCalled();
    expect(catalog.skills).toEqual([]);
    expect(catalog.diagnostics.join("\n")).toContain("1 MiB");
  });

  it("rejects a file that grew after it was listed", async () => {
    const catalog = await discoverSkills({
      list: vi.fn().mockResolvedValue({
        objects: [{ key: "skills/big/SKILL.md", size: 10 }],
        truncated: false,
      }),
      get: vi.fn().mockResolvedValue({
        size: (1 << 20) + 1,
        text: async () => body("big"),
      }),
    } as unknown as R2Bucket);

    expect(catalog.skills).toEqual([]);
    expect(catalog.diagnostics.join("\n")).toContain("1 MiB");
  });

  it("reports an entry that vanished between list and get", async () => {
    const catalog = await discoverSkills({
      list: vi.fn().mockResolvedValue({
        objects: [{ key: "skills/gone/SKILL.md", size: 40 }],
        truncated: false,
      }),
      get: vi.fn().mockResolvedValue(null),
    } as unknown as R2Bucket);

    expect(catalog.skills).toEqual([]);
    expect(catalog.diagnostics.join("\n")).toContain("skills/gone/SKILL.md");
  });

  it("fails instead of returning a partial catalog when R2 breaks", async () => {
    await expect(
      discoverSkills({
        list: vi.fn().mockRejectedValue(new Error("R2 unavailable")),
        get: vi.fn(),
      } as unknown as R2Bucket),
    ).rejects.toThrow("R2 unavailable");

    await expect(
      discoverSkills({
        list: vi.fn().mockResolvedValue({
          objects: [{ key: "skills/demo/SKILL.md", size: 40 }],
          truncated: false,
        }),
        get: vi.fn().mockRejectedValue(new Error("R2 read failed")),
      } as unknown as R2Bucket),
    ).rejects.toThrow("R2 read failed");
  });
});
