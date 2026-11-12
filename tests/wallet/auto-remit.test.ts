import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import { CHAINS, erc20Abi } from "../../src/wallet/chain";
import {
  setWalletChainOverride,
  type WalletNotice,
} from "../../src/wallet/wallet-do";
import { FakeChain, PRIVATE_KEY_SENTINEL } from "../helpers/fake-chain";
import { resetWallet } from "../helpers/wallet";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const START = Date.UTC(2030, 0, 1, 9, 0, 0);
const OWNER = "0x1111111111111111111111111111111111111111" as Address;

let now = START;

function wallet() {
  return env.WALLET.get(env.WALLET.idFromName("global"));
}

function useChain(chain: FakeChain): FakeChain {
  setWalletChainOverride({ chain, owner: OWNER });
  return chain;
}

function funded(chain: FakeChain, usdc = 100_000_000n): FakeChain {
  chain.balances.USDC = usdc;
  return chain;
}

const input = {
  dailySpendUsd: 2,
  balanceUsd: 10,
  metabolismStarted: true,
};

function transferAmount(tx: { data: Hex }): bigint {
  const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
  return (decoded.args as readonly [Address, bigint])[1];
}

async function recordNotices(): Promise<WalletNotice[]> {
  const notices: WalletNotice[] = [];
  await runInDurableObject(wallet(), (instance) => {
    instance.notifyOwner = async (event) => {
      notices.push(event);
    };
  });
  return notices;
}

async function insertConfirmed(id: string, at: number): Promise<void> {
  await runInDurableObject(wallet(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO remittances
        (id, at, usdc, reason, tx_hash, status, settled_at, error)
       VALUES (?, ?, ?, ?, NULL, 'confirmed', NULL, NULL)`,
      id,
      at,
      "10000000",
      "seeded",
    );
  });
}

beforeEach(async () => {
  now = START;
  setClockOverride({
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  setWalletChainOverride(null);
  await resetWallet();
});

afterEach(async () => {
  setWalletChainOverride(null);
  setClockOverride(null);
  await resetWallet();
});

describe("WalletDO auto remittance", () => {
  it("sends 21 days of spend and tells the owner", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);
    const notices = await recordNotices();

    const result = await wallet().autoRemit(input);

    expect(result).toMatchObject({ ok: true, usdc: 32 });
    if (result === null || !result.ok) throw new Error("expected a remittance");
    expect(chain.sent).toHaveLength(1);
    expect(transferAmount(chain.sent[0])).toBe(32_000_000n);
    expect(notices).toEqual([
      {
        kind: "wallet.remit",
        id: result.id,
        usdc: 32,
        shortUsd: 0,
        txUrl: expect.stringMatching(/^https:\/\/basescan\.org\/tx\/0x/),
        body: "",
      },
    ]);
  });

  it("sends what the wallet has and reports the shortfall", async () => {
    const chain = funded(new FakeChain(), 20_000_000n);
    useChain(chain);
    const notices = await recordNotices();

    const result = await wallet().autoRemit(input);

    expect(result).toMatchObject({ ok: true, usdc: 20 });
    expect(chain.sent).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "wallet.remit",
      usdc: 20,
      shortUsd: 12,
    });
  });

  it("does nothing when the balance is below the minimum", async () => {
    const chain = funded(new FakeChain(), 4_000_000n);
    useChain(chain);
    const notices = await recordNotices();

    expect(await wallet().autoRemit(input)).toBeNull();
    expect(chain.sent).toHaveLength(0);
    expect(notices).toEqual([]);
  });

  it("does nothing while an earlier remittance awaits the owner", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);
    await insertConfirmed("waiting", now - 60_000);
    const notices = await recordNotices();

    expect(await wallet().autoRemit(input)).toBeNull();
    expect(chain.sent).toHaveLength(0);
    expect(notices).toEqual([]);
  });

  it.each([
    ["the metabolism has not started", { ...input, metabolismStarted: false }],
    ["there is no daily spend", { ...input, dailySpendUsd: 0 }],
  ])("does nothing when %s", async (_name, values) => {
    const chain = funded(new FakeChain());
    useChain(chain);
    const notices = await recordNotices();

    expect(await wallet().autoRemit(values)).toBeNull();
    expect(chain.sent).toHaveLength(0);
    expect(notices).toEqual([]);
  });

  it("tells the owner when the transaction reverts", async () => {
    const chain = funded(new FakeChain());
    chain.defaultReceipt = { status: "reverted", gasWei: 0n };
    useChain(chain);
    const notices = await recordNotices();

    await wallet().autoRemit(input);

    expect(chain.sent).toHaveLength(1);
    expect(notices).toEqual([
      {
        kind: "wallet.remitFailed",
        usdc: 32,
        reason: "wallet.error.reverted",
        body: "",
      },
    ]);
  });

  it("tells the owner when the balance cannot be read", async () => {
    const chain = funded(new FakeChain());
    chain.tokenBalanceError = new Error(PRIVATE_KEY_SENTINEL);
    useChain(chain);
    const notices = await recordNotices();

    expect(await wallet().autoRemit(input)).toBeNull();

    expect(chain.sent).toHaveLength(0);
    expect(notices).toEqual([
      {
        kind: "wallet.remitFailed",
        usdc: 32,
        reason: "wallet.error.rpc",
        body: "",
      },
    ]);
  });

  it("wakes itself to confirm a late transaction and announces it once", async () => {
    const chain = funded(new FakeChain());
    chain.broadcastMode = "throw-unmined";
    useChain(chain);
    const notices = await recordNotices();

    const first = await wallet().autoRemit(input);

    expect(first).toMatchObject({ ok: false, inFlight: true });
    expect(chain.sent).toHaveLength(1);
    expect(notices).toEqual([]);

    const hash = await runInDurableObject(wallet(), (_instance, state) =>
      state.storage.sql
        .exec<{ tx_hash: Hex }>(
          `SELECT tx_hash FROM remittances ORDER BY rowid LIMIT 1`,
        )
        .toArray()[0]?.tx_hash,
    );
    if (hash === undefined) throw new Error("expected a signed hash");
    chain.receipts.set(hash, { status: "success", gasWei: 0n });

    expect(await runDurableObjectAlarm(wallet())).toBe(true);

    const status = await runInDurableObject(wallet(), (_instance, state) =>
      state.storage.sql
        .exec<{ status: string }>(`SELECT status FROM remittances`)
        .toArray()[0]?.status,
    );
    expect(status).toBe("confirmed");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "wallet.remit",
      usdc: 32,
      shortUsd: 0,
    });
  });

  it("serializes concurrent calls into a single transfer", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);
    const notices = await recordNotices();

    await Promise.all([wallet().autoRemit(input), wallet().autoRemit(input)]);

    expect(chain.sent).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });

  it("stays quiet when the broadcast throws but lands, then confirms once", async () => {
    const chain = funded(new FakeChain());
    chain.broadcastMode = "throw-mined";
    useChain(chain);
    const notices = await recordNotices();

    const first = await wallet().autoRemit(input);

    expect(first).toMatchObject({ ok: false, inFlight: true });
    expect(chain.sent).toHaveLength(1);
    expect(notices).toEqual([]);

    chain.broadcastMode = "ok";
    const second = await wallet().autoRemit(input);

    expect(second).toBeNull();
    expect(chain.sent).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "wallet.remit",
      usdc: 32,
      shortUsd: 0,
    });
  });
});
