import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN = /\b(DELETE|PUT|PATCH)\b|withdraw|placeOrder|cancelOrder/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("exchange adapters are read-only", () => {
  it("never mentions a write verb", () => {
    const files = sources("src/exchange");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const match = FORBIDDEN.exec(text);
      expect(match, `${file} contains ${match?.[0]}`).toBeNull();
    }
  });

  it("only allows POST in the transport, inside the read allowlist", () => {
    const offenders = sources("src/exchange").filter(
      (file) =>
        readFileSync(file, "utf8").includes("POST") &&
        !file.endsWith("src/exchange/http.ts"),
    );
    expect(offenders).toEqual([]);
  });
});
