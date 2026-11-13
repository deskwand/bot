import { parseDocument } from "yaml";
import { MAX_DRAFT_BYTES, SKILL_NAME } from "../env/r2-env";
import type { ArtifactStore } from "../artifact-store";

/** One installed skill, as the model sees it before opening the entry. */
export type SkillEntry = {
  name: string;
  description: string;
  path: string;
};

/** What a task fixes at start: the entries plus why some were skipped. */
export type SkillCatalog = {
  skills: SkillEntry[];
  diagnostics: string[];
};

const FRONT_MATTER = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const ENTRY_KEY = /^skills\/([^/]+)\/SKILL\.md$/;
const MAX_DESCRIPTION = 1024;

/**
 * Reads one `SKILL.md` header. Returns the entry, or a short diagnostic when
 * the file cannot describe a skill. Only metadata is used; the body stays on
 * disk until the model reads it.
 */
export function parseSkill(name: string, content: string): SkillEntry | string {
  const bad = (why: string) => `/skills/${name}/SKILL.md: ${why}`;
  if (!SKILL_NAME.test(name)) return bad("invalid directory name");

  const match = FRONT_MATTER.exec(content);
  if (match === null) return bad("missing YAML front matter");

  try {
    const doc = parseDocument(match[1]!, { schema: "core", uniqueKeys: true });
    if (doc.errors.length > 0) return bad("invalid YAML");
    // Aliases would let a tiny file expand without bound.
    const data: unknown = doc.toJS({ maxAliasCount: 0 });
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return bad("front matter must be an object");
    }

    const fields = data as Record<string, unknown>;
    if (fields.name !== name) return bad("name must match its directory");
    const description = fields.description;
    if (
      typeof description !== "string" ||
      description.trim().length === 0 ||
      description.length > MAX_DESCRIPTION
    ) {
      return bad(
        "description must be a nonempty string of at most 1024 characters",
      );
    }

    return { name, description: description.trim(), path: `/skills/${name}/SKILL.md` };
  } catch {
    return bad("invalid or unsupported YAML");
  }
}

/**
 * Walks `skills/` and reads every entry header. A broken entry is skipped with
 * a diagnostic; an R2 failure rejects, so a partial catalog is never stored.
 */
export async function discoverSkills(bucket: ArtifactStore): Promise<SkillCatalog> {
  const catalog: SkillCatalog = { skills: [], diagnostics: [] };
  const tooLarge = (key: string) =>
    catalog.diagnostics.push(`/${key}: file exceeds 1 MiB`);

  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "skills/", cursor });
    for (const object of page.objects) {
      const match = ENTRY_KEY.exec(object.key);
      if (match === null) continue;
      const name = match[1]!;
      if (object.size > MAX_DRAFT_BYTES) {
        tooLarge(object.key);
        continue;
      }

      const entry = await bucket.get(object.key);
      if (entry === null) {
        catalog.diagnostics.push(`/${object.key}: entry disappeared`);
        continue;
      }
      if (entry.size > MAX_DRAFT_BYTES) {
        tooLarge(object.key);
        continue;
      }

      const parsed = parseSkill(name, await entry.text());
      if (typeof parsed === "string") catalog.diagnostics.push(parsed);
      else catalog.skills.push(parsed);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);

  catalog.skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  catalog.diagnostics.sort();
  return catalog;
}
