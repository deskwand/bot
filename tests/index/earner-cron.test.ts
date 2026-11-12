import { env, runInDurableObject } from "cloudflare:test";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotsRepo } from "../../src/butler/bots-repo";
import { setClockOverride } from "../../src/butler/notifier";
import { setWalletChainOverride } from "../../src/wallet/wallet-do";
import worker from "../../src/index";
import { t } from "../../src/i18n";
import { FakeChain } from "../helpers/fake-chain";
import { resetWallet } from "../helpers/wallet";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const START = Date.UTC(2030, 0, 1, 9, 0, 0);
const OWNER = "0x1111111111111111111111111111111111111111" as Address;

let now = START;

function ownerButler() {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

async function earnerNames(): Promise<string[]> {
  const ids = await runInDurableObject(ownerButler(), (_instance, state) =>
    new BotsRepo(state.storage.sql).list().map((row) => row.id),
  );
  const names: string[] = [];
  for (const id of ids) {
    const snapshot = await env.BOT.get(env.BOT.idFromName(id)).snapshot();
    if (snapshot?.meta.earner === true) names.push(snapshot.meta.name);
  }
  return names;
}

async function cleanupOwnerBots(): Promise<void> {
  const ids = await runInDurableObject(ownerButler(), (_instance, state) =>
    new BotsRepo(state.storage.sql).list().map((row) => row.id),
  );
  for (const id of ids) {
    await env.BOT.get(env.BOT.idFromName(id)).destroy();
    await runInDurableObject(ownerButler(), (_instance, state) => {
      new BotsRepo(state.storage.sql).remove(id);
    });
  }
}

function fundWallet(): void {
  const chain = new FakeChain();
  chain.balances.USDC = 5_000_000n;
  setWalletChainOverride({ chain, owner: OWNER });
}

beforeEach(async () => {
  now = START;
  setClockOverride({
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  await resetWallet();
  await cleanupOwnerBots();
});

afterEach(async () => {
  await cleanupOwnerBots();
  setWalletChainOverride(null);
  setClockOverride(null);
  await resetWallet();
});

describe("earner cron", () => {
  it("creates the earner in the wallet's 15-minute slot", async () => {
    fundWallet();

    await worker.scheduled(
      { scheduledTime: Date.UTC(2030, 0, 1, 9, 0) } as ScheduledController,
      env,
    );

    expect(await earnerNames()).toEqual([t("zh", "wallet.earner.name")]);
  });

  it("does nothing outside the 15-minute slot", async () => {
    fundWallet();

    await worker.scheduled(
      { scheduledTime: Date.UTC(2030, 0, 1, 9, 7) } as ScheduledController,
      env,
    );

    expect(await earnerNames()).toEqual([]);
  });
});
