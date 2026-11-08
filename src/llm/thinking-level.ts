import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/**
 * The level a model uses when nobody configured one: as much thinking as is
 * sensible without the most expensive tier. `medium` when the model has it,
 * otherwise the highest level it offers below `max`, and `off` when thinking
 * cannot be tuned at all.
 *
 * No runtime imports on purpose: the desktop mirrors this function, and a node
 * test compares the two across the whole catalog.
 */
export function defaultLevelFrom(
  levels: readonly string[],
): ModelThinkingLevel {
  if (levels.includes("medium")) return "medium";
  const ranked = levels.filter((level) => level !== "off" && level !== "max");
  if (ranked.length > 0) return ranked[ranked.length - 1] as ModelThinkingLevel;
  const withoutOff = levels.filter((level) => level !== "off");
  // Nothing below max: the model only offers max, or nothing at all.
  return (withoutOff.length > 0 ? withoutOff[0] : "off") as ModelThinkingLevel;
}
