import { env } from "cloudflare:test";
import type { Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { createWalletRoutes, liveWalletReads } from "../../src/admin/wallet-routes";
import { setWalletChainOverride } from "../../src/wallet/wallet-do";
import { FakeChain } from "../helpers/fake-chain";
import { resetWallet } from "../helpers/wallet";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const OWNER = "0x1111111111111111111111111111111111111111" as Address;

function routes() {
  return createWalletRoutes(liveWalletReads(env));
}

function call(
  gateway: ReturnType<typeof createWalletRoutes>,
  init: { method?: string; path?: string } = {},
): Promise<Response> {
  return gateway.fetch(
    new Request(`https://example.com${init.path ?? "/admin/wallet/status"}`, {
      method: init.method ?? "GET",
    }),
  );
}

async function body(response: Response): Promise<string> {
  return response.clone().text();
}

afterEach(async () => {
  setWalletChainOverride(null);
  await resetWallet();
});

describe("wallet status route", () => {
  it("reports an unconfigured wallet without any address", async () => {
    setWalletChainOverride(null);
    const response = await call(routes());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false });
  });

  it("returns the derived address and the valuation", async () => {
    const chain = new FakeChain();
    chain.balances.USDC = 12_500_000n;
    setWalletChainOverride({ chain, owner: OWNER });
    await resetWallet();

    const response = await call(routes());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      address: chain.address,
      valueUsd: 12.5,
    });
  });

  it("keeps the address when the valuation cannot be read", async () => {
    const chain = new FakeChain();
    const gateway = createWalletRoutes({
      address: () => chain.address,
      value: async () => null,
    });

    const response = await call(gateway);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      address: chain.address,
      valueUsd: null,
    });
  });

  it("never echoes the owner address", async () => {
    const chain = new FakeChain();
    setWalletChainOverride({ chain, owner: OWNER });
    await resetWallet();

    const text = await body(await call(routes()));
    expect(text).not.toContain(OWNER);
    expect(text).toContain(chain.address);
  });

  it("answers other methods and paths with 404", async () => {
    const gateway = routes();
    expect((await call(gateway, { method: "POST" })).status).toBe(404);
    expect((await call(gateway, { path: "/admin/wallet/other" })).status).toBe(
      404,
    );
  });
});
