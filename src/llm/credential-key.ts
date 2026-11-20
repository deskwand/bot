/**
 * Storage key for a provider's subscription credential. Kept dependency-free
 * because three places use it: `LifeDO` (owner of the value), `model-auth.ts`
 * (the pi-ai credential store) and `admin/backup-rpc.ts` (which refuses to
 * export it).
 */
export const MODEL_CREDENTIAL_PREFIX = "model_auth:";

export function modelCredentialKey(providerId: string): string {
  return MODEL_CREDENTIAL_PREFIX + providerId;
}
