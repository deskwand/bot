import { describe, expect, it } from "vitest";
import { en, zh } from "../../src/i18n";

/** Characters rendered as emoji by default, plus the emoji variation selector. */
const EMOJI = /\p{Extended_Pictographic}|\uFE0F/u;

function leaves(
  tree: unknown,
  prefix = "",
): Array<[key: string, value: string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out.push([path, value]);
    } else {
      out.push(...leaves(value, path));
    }
  }
  return out;
}

describe("user-visible copy", () => {
  it("has no emoji in user-visible copy", () => {
    for (const [locale, tree] of [
      ["zh", zh],
      ["en", en],
    ] as const) {
      for (const [key, value] of leaves(tree)) {
        expect(value, `${locale}:${key}`).not.toMatch(EMOJI);
      }
    }
  });

  it("keeps the plain check mark used by tool progress", () => {
    expect("✓").not.toMatch(EMOJI);
  });
});
