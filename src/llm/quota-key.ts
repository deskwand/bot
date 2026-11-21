/**
 * KV key for the cached subscription quota, kept dependency-free because two
 * places use it: `LifeDO` (owner of the value) and `admin/backup-rpc.ts`
 * (which refuses to export derived remote state).
 */
export const QUOTA_CACHE_KEY = "model_quota";
