import type { Models } from "@earendil-works/pi-ai/models";
import { ownerLocale } from "../i18n";
import { assertModelWindowSwitch } from "../llm/model-switch";
import { modelReadiness, type ModelRef, type Role } from "../llm/models";
import {
  WORKERS_AI_DEFAULT_MODEL_ID,
  WORKERS_AI_PROVIDER_ID,
} from "../llm/workers-ai";
import { readRuntimeConfig } from "../runtime-config";
import { readTier } from "./client";
import type { Tier } from "./vitals";

/** The model a tier asks for, before any safety check. */
export function modelForTier(
  tier: Tier,
  role: Role,
  configured: ModelRef,
  frugal: ModelRef | undefined,
): ModelRef {
  switch (tier) {
    case "ample":
      return configured;
    case "lean":
      return role === "task" ? (frugal ?? configured) : configured;
    case "critical":
      return frugal ?? configured;
    case "dormant":
      return {
        provider: WORKERS_AI_PROVIDER_ID,
        id: WORKERS_AI_DEFAULT_MODEL_ID,
      };
  }
}

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.id === b.id;
}

/**
 * `modelForTier`, unless the candidate cannot run or would shrink the window
 * too far from `active`; then `configured`. Never throws.
 */
export async function effectiveModelRef(
  env: Env,
  models: Models,
  role: Role,
  configured: ModelRef,
  active?: ModelRef,
): Promise<ModelRef> {
  try {
    const tier = await readTier(env);
    const candidate = modelForTier(
      tier,
      role,
      configured,
      readRuntimeConfig(env).models.frugal,
    );
    if (sameModel(candidate, configured)) return configured;
    if (modelReadiness(env, models, candidate) !== undefined) return configured;
    assertModelWindowSwitch(
      models,
      active ?? configured,
      candidate,
      ownerLocale(env),
    );
    return candidate;
  } catch {
    return configured;
  }
}
