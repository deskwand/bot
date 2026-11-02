import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATALOG_PATH,
  OUTPUT_PATH,
  buildOpenCodeGoTable,
} from "../scripts/generate-opencode-models";

type Endpoint = { api: string; baseUrl: string };

function parseGeneratedTable(source: string): Map<string, Endpoint> {
  const table = new Map<string, Endpoint>();
  const entryPattern =
    /^\t("(?:[^"\\]|\\.)*"):\s+\{API: "([^"]+)", BaseURL: "([^"]+)"\},$/;
  for (const line of source.split("\n")) {
    const match = entryPattern.exec(line);
    if (!match) continue;
    table.set(JSON.parse(match[1]!) as string, {
      api: match[2]!,
      baseUrl: match[3]!,
    });
  }
  return table;
}

describe("OpenCode Go generated model table", () => {
  it("matches the installed pi-ai catalog exactly", () => {
    const catalog: unknown = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    const expected = buildOpenCodeGoTable(catalog);
    const source = readFileSync(OUTPUT_PATH, "utf8");
    const generated = parseGeneratedTable(source);

    expect(generated.size).toBe(expected.size);
    expect([...generated.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [id, endpoint] of expected) {
      expect(generated.get(id), id).toEqual(endpoint);
    }
  });

  it("documents how to regenerate the table", () => {
    const source = readFileSync(OUTPUT_PATH, "utf8");
    expect(source).toContain("scripts/generate-opencode-models.ts");
    expect(source).toContain("node --experimental-strip-types");
  });
});
