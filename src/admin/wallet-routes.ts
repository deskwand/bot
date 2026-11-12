/**
 * Wallet status route: one authenticated read for the desktop settings page.
 * The response is either "not configured" or the public address plus its
 * valuation. The owner address, the private key and the RPC URL never appear.
 */

import type { Address } from "viem";
import { readWalletValue } from "../wallet/client";
import { walletAddress } from "../wallet/wallet-do";

export const WALLET_STATUS_PATH = "/admin/wallet/status";

export type WalletReads = {
  address(): Address | null;
  value(): Promise<number | null>;
};

/** The production reads; tests may replace them with fixed values. */
export function liveWalletReads(env: Env): WalletReads {
  return {
    address: () => walletAddress(env),
    value: () => readWalletValue(env),
  };
}

export function createWalletRoutes(reads: WalletReads): {
  fetch(req: Request): Promise<Response>;
} {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "GET" || url.pathname !== WALLET_STATUS_PATH) {
        return new Response("Not found", { status: 404 });
      }
      const address = reads.address();
      if (address === null) return json({ configured: false });
      const valueUsd = await reads.value();
      return json({ configured: true, address, valueUsd });
    },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
