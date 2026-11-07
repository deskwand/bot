import type { Models } from "@earendil-works/pi-ai/models";
import { t, type Locale } from "../i18n";
import type { ModelRef } from "./models";

export class ModelSwitchError extends Error {
  override name = "ModelSwitchError";
}

// Allow ordinary model changes; reject only reductions greater than fourfold.
const MAX_WINDOW_SHRINK = 4;

/** Compare with the current model, never a historical high-water mark. */
export function assertModelWindowSwitch(
  models: Models,
  current: ModelRef | undefined,
  target: ModelRef,
  locale: Locale,
): void {
  if (!current || (current.provider === target.provider && current.id === target.id)) return;
  const from = models.getModel(current.provider, current.id)?.contextWindow;
  const to = models.getModel(target.provider, target.id)?.contextWindow;
  if (!from || !to || !Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
    throw new ModelSwitchError(t(locale, "llm.windowUnknown"));
  }
  if (to < from / MAX_WINDOW_SHRINK) {
    throw new ModelSwitchError(t(locale, "llm.windowDowngrade", {
      source: `${current.provider}/${current.id}`,
      target: `${target.provider}/${target.id}`,
      from,
      to,
    }));
  }
}
