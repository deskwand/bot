import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { lifeStub } from "../life/client";
import { SUBSCRIPTION_PROVIDER_IDS } from "./providers";

/**
 * Reads a subscription credential without ever throwing. Readiness gates and
 * the desktop status page treat any storage failure as "not signed in".
 */
export async function readModelCredential(
  env: Env,
  providerId: string,
): Promise<Credential | undefined> {
  if (!SUBSCRIPTION_PROVIDER_IDS.has(providerId)) return undefined;
  try {
    return await lifeStub(env).modelCredential(providerId);
  } catch {
    return undefined;
  }
}

/** The rotating secret a compare-and-set is keyed on; null = no credential. */
function refreshOf(credential: Credential | undefined): string | null {
  return credential !== undefined && credential.type === "oauth"
    ? credential.refresh
    : null;
}

/** Writes a subscription credential; the login route calls this once. */
export async function saveModelCredential(
  env: Env,
  providerId: string,
  credential: Credential,
): Promise<void> {
  await lifeStub(env).saveModelCredential(providerId, credential);
}

export async function deleteModelCredential(
  env: Env,
  providerId: string,
): Promise<void> {
  await lifeStub(env).deleteModelCredential(providerId);
}

/**
 * Sequential writes per provider. pi-ai owns the refresh lock inside one
 * `Models` instance, but two calls that each built their own instance (a task
 * and the butler, say) would otherwise read the same credential, both refresh
 * it, and let the loser write a rotated-out refresh token back.
 */
const writes = new Map<string, Promise<unknown>>();

function serialized<T>(providerId: string, work: () => Promise<T>): Promise<T> {
  const previous = writes.get(providerId) ?? Promise.resolve();
  const next = previous.then(work, work);
  writes.set(
    providerId,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * pi-ai's credential store, backed by the life object. Only subscription
 * providers are consulted: every other provider keeps resolving through its
 * `MODEL_KEY_*` secret without an extra round trip.
 */
export function modelCredentialStore(env: Env): CredentialStore {
  return {
    async read(providerId) {
      return await readModelCredential(env, providerId);
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const infos: CredentialInfo[] = [];
      for (const providerId of SUBSCRIPTION_PROVIDER_IDS) {
        const credential = await readModelCredential(env, providerId);
        if (credential !== undefined) {
          infos.push({ providerId, type: credential.type });
        }
      }
      return infos;
    },
    async modify(providerId, fn) {
      if (!SUBSCRIPTION_PROVIDER_IDS.has(providerId)) return undefined;
      return await serialized(providerId, async () => {
        const current = await readModelCredential(env, providerId);
        const next = await fn(current);
        if (next === undefined) return current;
        // The life object is the only writer that matters across isolates: a
        // compare-and-set keeps a concurrent refresh from reviving a rotated
        // refresh token. Losing it means someone else already stored a newer
        // credential, so hand theirs back.
        const written = await lifeStub(env).saveModelCredentialIfCurrent(
          providerId,
          refreshOf(current),
          next,
        );
        return written.saved ? next : written.current;
      });
    },
    async delete(providerId) {
      if (!SUBSCRIPTION_PROVIDER_IDS.has(providerId)) return;
      await serialized(providerId, () => deleteModelCredential(env, providerId));
    },
  };
}
