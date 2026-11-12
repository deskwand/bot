import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readRuntimeConfig } from "../runtime-config";

export type WalletConfig = {
  privateKey: Hex;
  ownerAddress: Address;
  rpcUrl: string;
};

const DEFAULT_RPC_URL = "https://mainnet.base.org";
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Sanitized: callers never receive the value that failed validation. */
function warn(reason: string): void {
  console.warn(`wallet skipped: ${reason}`);
}

/** A missing or unreadable document falls back to the public RPC. */
function rpcUrl(env: Env): string | null {
  let configured: unknown;
  try {
    configured = readRuntimeConfig(env).wallet?.rpcUrl;
  } catch {
    return DEFAULT_RPC_URL;
  }
  if (configured === undefined) return DEFAULT_RPC_URL;
  if (typeof configured !== "string" || configured.trim() === "") return null;
  const value = configured.trim();
  try {
    if (new URL(value).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return value;
}

/**
 * The wallet is configured only when every field is present and valid. A bad
 * field means "not configured" (exactly like an upgraded-away deployment),
 * never a partially working wallet.
 */
export function walletConfig(env: Env): WalletConfig | null {
  const privateKey = env.WALLET_PRIVATE_KEY;
  const ownerAddress = env.WALLET_OWNER_ADDRESS;
  // Unset secrets are the normal, unconfigured state: stay silent.
  if (
    privateKey === undefined ||
    privateKey === "" ||
    ownerAddress === undefined ||
    ownerAddress === ""
  ) {
    return null;
  }
  if (typeof privateKey !== "string" || !PRIVATE_KEY_PATTERN.test(privateKey)) {
    warn("WALLET_PRIVATE_KEY is malformed");
    return null;
  }
  if (typeof ownerAddress !== "string" || !isAddress(ownerAddress)) {
    warn("WALLET_OWNER_ADDRESS is malformed");
    return null;
  }
  if (ownerAddress.toLowerCase() === zeroAddress) {
    warn("WALLET_OWNER_ADDRESS is the zero address");
    return null;
  }

  let walletAddress: Address;
  try {
    walletAddress = privateKeyToAccount(privateKey as Hex).address;
  } catch {
    warn("WALLET_PRIVATE_KEY is not a valid key");
    return null;
  }
  if (ownerAddress.toLowerCase() === walletAddress.toLowerCase()) {
    warn("WALLET_OWNER_ADDRESS is the wallet itself");
    return null;
  }

  const configuredRpcUrl = rpcUrl(env);
  if (configuredRpcUrl === null) {
    warn("wallet.rpcUrl must be an https URL");
    return null;
  }

  return {
    privateKey: privateKey as Hex,
    ownerAddress,
    rpcUrl: configuredRpcUrl,
  };
}
