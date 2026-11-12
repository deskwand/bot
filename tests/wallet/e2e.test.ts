import { env, runInDurableObject } from "cloudflare:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import type { SpendEntry } from "../../src/life/books";
import { lifeStub } from "../../src/life/client";
import { createLifeTools, type LifeToolDeps } from "../../src/life/tools";
import type { Tier } from "../../src/life/vitals";
import { CHAINS, erc20Abi } from "../../src/wallet/chain";
import { readWalletStatus } from "../../src/wallet/client";
import { remitAmountUsd, REMIT_STALE_MS } from "../../src/wallet/guard";
import {
  setWalletChainOverride,
  walletConfigured,
  walletStub,
  type WalletNotice,
} from "../../src/wallet/wallet-do";
import { FakeChain } from "../helpers/fake-chain";
import { resetLife } from "../helpers/life";
import { resetWallet } from "../helpers/wallet";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const DAY_MS = 86_400_000;
const START = Date.UTC(2030, 0, 1, 9, 0, 0);
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const USDC = CHAINS.base.tokens.USDC?.address as Address;

let now = START;
let notices: WalletNotice[] = [];

function life() {
  return lifeStub(env);
}

function wallet() {
  return walletStub(env);
}

function entry(usd: number): SpendEntry {
  return {
    callId: crypto.randomUUID(),
    at: now,
    source: "butler",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    usd,
    priced: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Polls until the asynchronous remittance path has run. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await sleep(0);
  }
  expect(condition()).toBe(true);
}

async function setup(
  chain: FakeChain | null,
): Promise<{ tier: Tier; runwayDays: number | null }[]> {
  setWalletChainOverride(chain === null ? null : { chain, owner: OWNER });
  notices = [];
  const tiers: { tier: Tier; runwayDays: number | null }[] = [];
  await runInDurableObject(life(), (instance) => {
    instance.notifyTierChange = async (tier, runwayDays) => {
      tiers.push({ tier, runwayDays });
    };
  });
  await runInDurableObject(wallet(), (instance) => {
    instance.notifyOwner = async (event) => {
      notices.push(event);
    };
  });
  return tiers;
}

function funded(usdc = 100_000_000n): FakeChain {
  const chain = new FakeChain();
  chain.balances.USDC = usdc;
  return chain;
}

function transfer(tx: { data: Hex }): {
  recipient: Address;
  amount: bigint;
} {
  const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
  const [recipient, amount] = decoded.args as readonly [Address, bigint];
  return { recipient, amount };
}

function lifeDeps(): LifeToolDeps {
  return {
    vitals: () => life().vitals(),
    credit: (usd, note, source) => life().recordCredit(usd, note, source),
    settleRemittance: walletConfigured(env)
      ? (id) => wallet().settleRemittance(id)
      : undefined,
    wallet: walletConfigured(env)
      ? () => readWalletStatus(env)
      : undefined,
    calibrate: (balanceUsd, note) => life().calibrate(balanceUsd, note),
    effectiveModels: async () => ({
      butler: { provider: "test", id: "butler-model" },
      task: { provider: "test", id: "task-model" },
    }),
    locale: "zh",
  };
}

async function run(
  name: string,
  args: Record<string, unknown> = {},
) {
  const tool = createLifeTools(lifeDeps()).find(
    (candidate) => candidate.name === name,
  );
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(args as never, {} as never, {} as never);
}

function text(outcome: {
  output?: { type: string; text?: string }[];
}): string {
  return (outcome.output?.[0] as { text: string }).text;
}

async function remittance(
  id: string,
): Promise<{ status: string; settled_at: number | null } | undefined> {
  return runInDurableObject(wallet(), (_instance, state) =>
    state.storage.sql
      .exec<{ status: string; settled_at: number | null }>(
        `SELECT status, settled_at FROM remittances WHERE id = ?`,
        id,
      )
      .toArray()[0],
  );
}

beforeEach(async () => {
  now = START;
  setClockOverride({
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  setWalletChainOverride(null);
  await resetLife();
  await resetWallet();
});

afterEach(async () => {
  setWalletChainOverride(null);
  setClockOverride(null);
  await resetLife();
  await resetWallet();
});

describe("wallet remittance lifecycle end to end", () => {
  it("remits on lean, stays put on critical, then books a settled credit as earned", async () => {
    const chain = funded();
    const tiers = await setup(chain);

    // 1. A single $2 spend of a $20 credit drops the tier to lean.
    await life().recordCredit(20, "");
    await life().recordSpend(entry(2));
    await waitFor(() => chain.sent.length === 1 && notices.length === 1);

    const first = notices[0];
    if (first.kind !== "wallet.remit") {
      throw new Error(`expected a remit notice, got ${first.kind}`);
    }
    expect(first.usdc).toBe(24);

    const lean = await life().vitals();
    expect(lean.tier).toBe("lean");
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].to.toLowerCase()).toBe(USDC.toLowerCase());
    const firstTransfer = transfer(chain.sent[0]);
    expect(firstTransfer.recipient).toBe(OWNER);
    expect(firstTransfer.amount).toBe(
      BigInt(
        Math.round(remitAmountUsd(lean.dailySpendUsd, lean.balanceUsd) * 1e6),
      ),
    );

    // 2. Another spend drops the tier to critical, but the remittance is
    //    still waiting for the owner, so nothing new is sent.
    now = START + 3 * DAY_MS;
    await life().recordSpend(entry(10));
    expect((await life().vitals()).tier).toBe("critical");
    await waitFor(() => tiers.length === 2);
    await sleep(20);
    expect(chain.sent).toHaveLength(1);
    expect(notices).toHaveLength(1);

    // 3. The owner reports the remittance id with a $50 credit: earned,
    //    settled, and ample again.
    const credited = await run("life_credit", {
      usd: 50,
      remittance_id: first.id,
    });
    expect(credited.isError).toBeUndefined();
    expect(text(credited)).toContain("已记入");

    const afterCredit = await life().vitals();
    expect(afterCredit.tier).toBe("ample");
    expect(afterCredit.balanceUsd).toBe(58);
    expect(await remittance(first.id)).toMatchObject({
      status: "confirmed",
      settled_at: now,
    });

    const latest = await runInDurableObject(life(), (_instance, state) =>
      state.storage.sql
        .exec<{ source: string }>(
          `SELECT source FROM credit ORDER BY id DESC LIMIT 1`,
        )
        .toArray()[0],
    );
    expect(latest?.source).toBe("earned");

    // 4. A later spend drops the tier again; the settled remittance no longer
    //    blocks a new one.
    now = START + 4 * DAY_MS;
    await life().recordSpend(entry(4));
    expect((await life().vitals()).tier).toBe("lean");
    await waitFor(() => chain.sent.length === 2 && notices.length === 2);

    const second = notices[1];
    if (second.kind !== "wallet.remit") {
      throw new Error(`expected a remit notice, got ${second.kind}`);
    }
    expect(second.usdc).toBe(30);
    expect(chain.sent).toHaveLength(2);
    expect(transfer(chain.sent[1])).toEqual({
      recipient: OWNER,
      amount: 30_000_000n,
    });
  });

  it("remits again only after the unconfirmed remittance goes stale", async () => {
    const chain = funded();
    const tiers = await setup(chain);

    await life().recordCredit(20, "");
    await life().recordSpend(entry(2));
    await waitFor(() => chain.sent.length === 1 && notices.length === 1);

    // Pull the tier back up with a credit that does not settle the remittance.
    await life().recordCredit(50, "");
    expect((await life().vitals()).tier).toBe("ample");

    // Within the 72-hour window a new drop is blocked by the pending remit.
    await life().recordSpend(entry(10));
    expect((await life().vitals()).tier).toBe("lean");
    await waitFor(() => tiers.length === 3);
    await sleep(20);
    expect(chain.sent).toHaveLength(1);

    // Past 72 hours the old remittance is stale, so the next drop remits.
    now = START + REMIT_STALE_MS + 1;
    await life().recordSpend(entry(30));
    expect((await life().vitals()).tier).toBe("critical");
    await waitFor(() => chain.sent.length === 2 && notices.length === 2);

    const second = notices[1];
    if (second.kind !== "wallet.remit") {
      throw new Error(`expected a remit notice, got ${second.kind}`);
    }
    expect(second.usdc).toBe(100);
    expect(chain.sent).toHaveLength(2);
    expect(transfer(chain.sent[1])).toEqual({
      recipient: OWNER,
      amount: 100_000_000n,
    });
  });

  it("behaves exactly as before the upgrade when the wallet is unconfigured", async () => {
    await setup(null);
    expect(walletConfigured(env)).toBe(false);

    await life().recordCredit(20, "");
    await life().recordSpend(entry(2));
    expect((await life().vitals()).tier).toBe("lean");
    await sleep(20);

    const rows = await runInDurableObject(wallet(), (_instance, state) =>
      state.storage.sql.exec(`SELECT id FROM remittances`).toArray(),
    );
    expect(rows).toHaveLength(0);

    const vitals = await run("life_vitals");
    expect(text(vitals)).toBe(
      [
        "额度：$18.00",
        "日均开销：$2.00",
        "还能活 9.0 天",
        "档位：吃紧",
        "开销来源：butler $2.00",
        "管家模型：test/butler-model",
        "任务模型：test/task-model",
      ].join("\n"),
    );

    const credit = createLifeTools(lifeDeps()).find(
      (candidate) => candidate.name === "life_credit",
    );
    if (!credit) throw new Error("missing tool life_credit");
    const parameters = credit.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(parameters.properties)).toEqual(["usd", "note"]);
    expect(parameters.required).toEqual(["usd"]);
  });
});
