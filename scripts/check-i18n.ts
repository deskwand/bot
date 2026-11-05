/**
 * Reports hard-coded Chinese literals that live outside the dictionaries.
 *
 * This script only reports for now: `npm run check:i18n` always exits 0 unless
 * an `--enforce <glob>` is passed. Files matching an enforce glob that still
 * contain Chinese literals make the command fail, which lets later
 * sub-projects switch directories over one at a time.
 *
 * Usage:
 *   node --experimental-strip-types scripts/check-i18n.ts
 *   node --experimental-strip-types scripts/check-i18n.ts --enforce 'desktop/frontend/src/**'
 *
 * Scanned paths are resolved against the current working directory.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type HanLiteral = { line: number; text: string };
export type SourceKind = "ts" | "go";

const HAN = /\p{Script=Han}+/u;

const SCAN_DIRS: { dir: string; extensions: string[] }[] = [
  { dir: "desktop/frontend/src", extensions: [".ts", ".tsx"] },
  { dir: "src", extensions: [".ts"] },
  { dir: "desktop/internal", extensions: [".go"] },
];

const EXCLUDED_GLOBS = [
  "**/*_test.go",
  "**/*.test.ts",
  "**/*.spec.ts",
  "desktop/frontend/src/mygo.ts",
  "desktop/frontend/src/i18n/**",
  "src/i18n/**",
  "desktop/internal/i18n/**",
];

type Literal = { line: number; text: string };
type ScanResult = { stripped: string; literals: Literal[] };

/** Blanks comments and literals, keeping newlines so line numbers stay valid. */
function scan(source: string, kind: SourceKind): ScanResult {
  const quotes = kind === "ts" ? ["'", '"', "`"] : ['"', "`"];
  const literals: Literal[] = [];
  let stripped = "";
  let i = 0;
  let line = 1;

  const blank = (text: string) => {
    for (const char of text) stripped += char === "\n" ? "\n" : " ";
  };

  while (i < source.length) {
    const char = source[i]!;

    if (char === "/" && source[i + 1] === "/") {
      const start = i;
      while (i < source.length && source[i] !== "\n") i++;
      blank(source.slice(start, i));
      continue;
    }

    if (char === "/" && source[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      if (i < source.length) i += 2;
      blank(source.slice(start, i));
      continue;
    }

    if (quotes.includes(char)) {
      const start = i;
      const startLine = line;
      const rawString = kind === "go" && char === "`";
      let content = "";
      i++;
      while (i < source.length) {
        const current = source[i]!;
        if (!rawString && current === "\\" && i + 1 < source.length) {
          content += current + source[i + 1];
          if (source[i + 1] === "\n") line++;
          i += 2;
          continue;
        }
        if (current === char) {
          i++;
          break;
        }
        if (current === "\n") line++;
        content += current;
        i++;
      }
      blank(source.slice(start, i));
      literals.push({ line: startLine, text: content });
      continue;
    }

    if (char === "\n") line++;
    stripped += char;
    i++;
  }

  return { stripped, literals };
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

function truncate(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return Array.from(normalized).slice(0, 60).join("");
}

function hanMatches(text: string): RegExpMatchArray[] {
  return Array.from(text.matchAll(new RegExp(HAN.source, "gu")));
}

/**
 * Returns every hard-coded Chinese literal in `source`. Comments are ignored;
 * string and template literals plus bare text (such as JSX text nodes) count.
 */
export function findHanLiterals(source: string, kind: SourceKind): HanLiteral[] {
  const { stripped, literals } = scan(source, kind);
  const hits: HanLiteral[] = [];

  for (const literal of literals) {
    const [first] = hanMatches(literal.text);
    if (!first || first.index === undefined) continue;
    hits.push({
      line: literal.line + lineAt(literal.text, first.index) - 1,
      text: truncate(literal.text),
    });
  }

  for (const match of hanMatches(stripped)) {
    hits.push({ line: lineAt(stripped, match.index ?? 0), text: truncate(match[0]) });
  }

  return hits.sort((a, b) => a.line - b.line);
}

/** Converts a simple glob (`*`, `**`, `?`) into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

function walk(dir: string, extensions: string[], files: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, extensions, files);
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(path);
    }
  }
}

function relativePath(path: string): string {
  return path.split("\\").join("/");
}

function kindFor(path: string): SourceKind | undefined {
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "ts";
  return undefined;
}

function loadAllowlist(): string[] {
  const file = resolve(import.meta.dirname, "i18n-allowlist.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseArgs(argv: string[]): string[] {
  const enforce: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--enforce") continue;
    while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      enforce.push(argv[i + 1]!);
      i++;
    }
  }
  return enforce;
}

function main(): void {
  const enforceGlobs = parseArgs(process.argv.slice(2)).map(globToRegExp);
  const excluded = [...EXCLUDED_GLOBS, ...loadAllowlist()].map(globToRegExp);

  const files: string[] = [];
  for (const { dir, extensions } of SCAN_DIRS) {
    walk(dir, extensions, files);
  }

  let hitCount = 0;
  let hitFiles = 0;
  let enforceFailed = false;

  for (const file of files.sort()) {
    const relative = relativePath(file);
    if (excluded.some((glob) => glob.test(relative))) continue;
    const kind = kindFor(relative);
    if (!kind) continue;

    const hits = findHanLiterals(readFileSync(file, "utf8"), kind);
    if (hits.length === 0) continue;

    hitFiles++;
    hitCount += hits.length;
    for (const hit of hits) {
      console.log(`${relative}:${hit.line}: ${hit.text}`);
    }
    if (enforceGlobs.some((glob) => glob.test(relative))) enforceFailed = true;
  }

  if (hitCount === 0) {
    console.log("No hard-coded Chinese literals found.");
  } else {
    console.log(`\n${hitCount} hard-coded Chinese literal(s) in ${hitFiles} file(s).`);
  }

  if (enforceFailed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
