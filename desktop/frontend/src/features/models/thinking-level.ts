/**
 * The level used when the role has none configured: as much thinking as is
 * sensible without the most expensive tier. Mirrors `src/llm/thinking-level.ts`
 * in the Worker; a node test compares the two across the whole catalog.
 *
 * No imports on purpose: that test compiles this file outside the frontend
 * project, where the `@/` alias used elsewhere in this folder does not resolve.
 */
export function defaultLevelFrom(levels: readonly string[]): string {
  if (levels.includes("medium")) return "medium";
  const ranked = levels.filter((level) => level !== "off" && level !== "max");
  if (ranked.length > 0) return ranked[ranked.length - 1]!;
  const withoutOff = levels.filter((level) => level !== "off");
  // Nothing below max: the model only offers max, or nothing at all.
  return withoutOff.length > 0 ? withoutOff[0]! : "off";
}
