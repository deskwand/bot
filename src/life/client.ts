import { emptyQuota, type QuotaSnapshot } from "../llm/quota";
import type { LifeDO } from "./life-do";
import type { Tier, Vitals } from "./vitals";

/** The one global life ledger. */
export function lifeStub(env: Env): DurableObjectStub<LifeDO> {
  return env.LIFE.get(env.LIFE.idFromName("global"));
}

/** Never throws: any failure yields "ample". */
export async function readTier(env: Env): Promise<Tier> {
  try {
    return (await lifeStub(env).vitals()).tier;
  } catch {
    return "ample";
  }
}

/** Never throws: null on any failure. */
export async function readVitals(env: Env): Promise<Vitals | null> {
  try {
    return await lifeStub(env).vitals();
  } catch {
    return null;
  }
}

/** Never throws: an unreadable snapshot is an empty one. */
export async function readQuota(
  env: Env,
  providers: string[],
): Promise<QuotaSnapshot> {
  if (providers.length === 0) return emptyQuota();
  try {
    return await lifeStub(env).quota(providers);
  } catch {
    return emptyQuota();
  }
}
