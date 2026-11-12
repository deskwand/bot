import { READ_TIMEOUT_MS } from "./guard";
import {
  walletConfigured,
  walletStub,
  type WalletStatus,
} from "./wallet-do";

/** Races a wallet read against the fixed read timeout; never throws. */
async function bounded<T>(work: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work(), timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Never throws: null when unconfigured, unreachable or slow. */
export async function readWalletStatus(
  env: Env,
): Promise<WalletStatus | null> {
  if (!walletConfigured(env)) return null;
  return bounded(async () => walletStub(env).status());
}

/** Never throws: null when unconfigured, unreachable or slow. */
export async function readWalletValue(env: Env): Promise<number | null> {
  if (!walletConfigured(env)) return null;
  return bounded(async () => walletStub(env).valueUsd());
}
