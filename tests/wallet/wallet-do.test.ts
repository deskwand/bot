import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import { CHAINS, erc20Abi, pairKey } from "../../src/wallet/chain";
import { readWalletStatus } from "../../src/wallet/client";
import { READ_TIMEOUT_MS, REMIT_STALE_MS, UNMINED_AFTER_MS } from "../../src/wallet/guard";
import type { RemittanceRow } from "../../src/wallet/store";
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
const USDC = CHAINS.base.tokens.USDC?.address as Address;

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

async function rows(): Promise<RemittanceRow[]> {
  return runInDurableObject(wallet(), (_instance, state) =>
    state.storage.sql
      .exec<RemittanceRow>(
        `SELECT id, at, usdc, reason, tx_hash, nonce, raw, status, settled_at, error
         FROM remittances ORDER BY rowid`,
      )
      .toArray(),
  );
}

async function stubNotices(): Promise<WalletNotice[]> {
  const notices: WalletNotice[] = [];
  await runInDurableObject(wallet(), (instance) => {
    instance.notifyOwner = async (event) => {
      notices.push(event);
    };
  });
  return notices;
}

async function insertPending(row: {
  id: string;
  at: number;
  usdc?: string;
  txHash: Hex | null;
  nonce?: number | null;
  raw?: Hex | null;
}): Promise<void> {
  await runInDurableObject(wallet(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO remittances
        (id, at, usdc, reason, tx_hash, nonce, raw, status, settled_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL)`,
      row.id,
      row.at,
      row.usdc ?? "10000000",
      "seeded",
      row.txHash,
      row.nonce ?? null,
      row.raw ?? null,
    );
  });
}

function transferAmount(tx: { data: Hex }): bigint {
  const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
  return (decoded.args as readonly [Address, bigint])[1];
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

describe("WalletDO valuation", () => {
  it("values USDC and the quoted tokens without quoting empty balances", async () => {
    const chain = funded(new FakeChain());
    chain.balances.WETH = 10n ** 18n;
    chain.quotes.set(pairKey("WETH", "USDC"), 3_000_000_000n);
    useChain(chain);

    const status = await wallet().status();

    expect(status.address).toBe(chain.address);
    expect(status.holdings.tokens).toEqual({
      USDC: 100_000_000n,
      WETH: 10n ** 18n,
      cbBTC: 0n,
    });
    expect(status.holdings.valueUsd).toBe(3100);
    expect(chain.quoteCalls).toEqual([pairKey("WETH", "USDC")]);
    expect(status.pendingRemittance).toBeNull();
  });
});

describe("WalletDO remittance", () => {
  it("signs one USDC transfer to the owner and confirms it", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);

    const result = await wallet().remit(10, "x");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an ok remittance");
    expect(result.usdc).toBe(10);
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].to.toLowerCase()).toBe(USDC.toLowerCase());
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: chain.sent[0].data,
    });
    expect(decoded.functionName).toBe("transfer");
    expect((decoded.args as readonly [Address, bigint])[0]).toBe(OWNER);
    expect(transferAmount(chain.sent[0])).toBe(10_000_000n);

    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      status: "confirmed",
      tx_hash: result.txHash,
      usdc: "10000000",
      reason: "x",
      settled_at: null,
    });
  });

  it("refuses an amount below the minimum without writing a row", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);

    const result = await wallet().remit(4.99, "x");

    expect(result).toMatchObject({
      ok: false,
      id: null,
      reason: "wallet.error.below_min",
      inFlight: false,
    });
    expect(chain.sent).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("marks a reverted transaction failed without sending again", async () => {
    const chain = funded(new FakeChain());
    chain.defaultReceipt = { status: "reverted", gasWei: 0n };
    useChain(chain);

    const result = await wallet().remit(10, "x");

    expect(result).toMatchObject({
      ok: false,
      reason: "wallet.error.reverted",
      inFlight: false,
    });
    expect(chain.sent).toHaveLength(1);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      status: "failed",
      error: "wallet.error.reverted",
    });
  });

  it("keeps a crafted hash when the broadcast throws but the tx landed", async () => {
    const chain = funded(new FakeChain());
    chain.broadcastMode = "throw-mined";
    useChain(chain);
    await stubNotices();

    const first = await wallet().remit(10, "first");

    expect(first).toMatchObject({ ok: false, inFlight: true });
    let stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe("pending");
    expect(stored[0].tx_hash).not.toBeNull();

    chain.broadcastMode = "ok";
    const second = await wallet().remit(20, "second");

    expect(second.ok).toBe(true);
    stored = await rows();
    expect(stored.map((row) => row.status)).toEqual([
      "confirmed",
      "confirmed",
    ]);
    expect(chain.sent.map(transferAmount)).toEqual([
      10_000_000n,
      20_000_000n,
    ]);
  });

  it("keeps replaying an unmined transaction instead of failing it", async () => {
    const chain = funded(new FakeChain());
    chain.broadcastMode = "throw-unmined";
    useChain(chain);
    const notices = await stubNotices();

    const first = await wallet().remit(10, "old");
    expect(first).toMatchObject({ ok: false, inFlight: true });
    const raw = chain.broadcasts[0];
    expect(chain.sent).toHaveLength(1);

    // Drop the alarm armed by the first attempt so the busy reconcile has to
    // arm its own.
    await runInDurableObject(wallet(), (_instance, state) =>
      state.storage.deleteAlarm(),
    );

    now = START + UNMINED_AFTER_MS + 1;
    const blocked = await wallet().remit(10, "new");

    expect(blocked).toMatchObject({
      ok: false,
      id: first.id,
      reason: "wallet.error.busy",
      inFlight: true,
    });
    expect(chain.broadcasts.at(-1)).toBe(raw);
    expect(chain.sent).toHaveLength(1);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: first.id,
      status: "pending",
      nonce: 0,
    });
    expect(notices).toEqual([
      {
        kind: "wallet.remitFailed",
        usdc: 10,
        reason: "wallet.error.stuck",
        body: "",
      },
    ]);

    // The busy reconcile armed the next wake-up.
    expect(await runDurableObjectAlarm(wallet())).toBe(true);

    // A later reconciliation replays again but does not notify twice.
    await wallet().remit(10, "again");
    expect(notices).toHaveLength(1);
  });

  it("fails a transaction whose nonce another transaction took", async () => {
    const chain = funded(new FakeChain());
    chain.broadcastMode = "throw-unmined";
    useChain(chain);
    await stubNotices();

    const first = await wallet().remit(10, "old");
    expect(first).toMatchObject({ ok: false, inFlight: true });
    expect((await rows())[0]).toMatchObject({ status: "pending", nonce: 0 });

    // Someone else spent nonce 0. While the transaction is young another
    // node may simply be ahead, so the wallet still waits.
    chain.latestNonce = 1;
    chain.broadcastMode = "ok";
    const early = await wallet().remit(20, "early");
    expect(early).toMatchObject({ ok: false, inFlight: true });
    expect(chain.sent).toHaveLength(1);

    // Old enough, and a second look still finds no receipt: give up on it.
    now = START + UNMINED_AFTER_MS + 1;
    const second = await wallet().remit(20, "new");

    expect(second.ok).toBe(true);
    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      id: first.id,
      status: "failed",
      error: "wallet.error.replaced",
    });
    expect(stored[1]).toMatchObject({ status: "confirmed", reason: "new" });
    expect(chain.sent).toHaveLength(2);
  });

  it("confirms a transaction that landed between the receipt and nonce reads", async () => {
    const chain = funded(new FakeChain());
    chain.broadcastMode = "throw-unmined";
    useChain(chain);
    await stubNotices();

    const first = await wallet().remit(10, "old");
    expect(first).toMatchObject({ ok: false, inFlight: true });
    const hash = (await rows())[0]!.tx_hash!;

    // The first receipt read misses it; by the second look it is mined.
    chain.latestNonce = 1;
    let reads = 0;
    const original = chain.receipt.bind(chain);
    chain.receipt = async (h, ms) => {
      if (h === hash && reads++ === 0) return null;
      if (h === hash) return { status: "success", gasWei: 0n };
      return original(h, ms);
    };
    now = START + UNMINED_AFTER_MS + 1;
    chain.broadcastMode = "ok";
    await wallet().remit(20, "new");

    const stored = await rows();
    expect(stored[0]).toMatchObject({ id: first.id, status: "confirmed" });
  });

  it("fails a pending row that never got a hash", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);
    await insertPending({ id: "abandoned", at: now, txHash: null });

    const result = await wallet().remit(10, "new");

    expect(result.ok).toBe(true);
    const stored = await rows();
    expect(stored[0]).toMatchObject({
      id: "abandoned",
      status: "failed",
      error: "wallet.error.abandoned",
    });
    expect(stored[1]).toMatchObject({ status: "confirmed" });
  });

  it("serializes concurrent remittances", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);

    const [first, second] = await Promise.all([
      wallet().remit(10, "a"),
      wallet().remit(20, "b"),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const signIndexes = chain.calls
      .map((call, index) => (call === "sign" ? index : -1))
      .filter((index) => index >= 0);
    const firstReceipt = chain.calls.findIndex((call) =>
      call.startsWith("receipt:"),
    );
    expect(signIndexes).toHaveLength(2);
    expect(firstReceipt).toBeGreaterThanOrEqual(0);
    expect(signIndexes[1]).toBeGreaterThan(firstReceipt);
  });

  it("never leaks the chain error when signing fails", async () => {
    const chain = funded(new FakeChain());
    chain.signError = new Error(PRIVATE_KEY_SENTINEL);
    useChain(chain);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await wallet().remit(10, "x");

      expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY_SENTINEL);
      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0].status).toBe("failed");
      expect(stored[0].error ?? "").not.toContain(PRIVATE_KEY_SENTINEL);
      for (const args of warn.mock.calls) {
        expect(args.map(String).join(" ")).not.toContain(
          PRIVATE_KEY_SENTINEL,
        );
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe("WalletDO settlement", () => {
  it("settles a confirmed remittance exactly once", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);
    const result = await wallet().remit(10, "x");
    if (!result.ok) throw new Error("expected an ok remittance");

    expect(await wallet().settleRemittance(result.id)).toBe("settled");
    expect(await wallet().settleRemittance(result.id)).toBe("already");
    expect(await wallet().settleRemittance("missing")).toBe("unknown");
  });

  it("reports an unsettled remittance until it goes stale after 72 hours", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);
    const result = await wallet().remit(10, "x");
    if (!result.ok) throw new Error("expected an ok remittance");

    expect((await wallet().status()).pendingRemittance).toMatchObject({
      id: result.id,
      usdc: 10,
    });

    now = START + REMIT_STALE_MS + 1;

    expect((await wallet().status()).pendingRemittance).toBeNull();
  });
});

describe("wallet client", () => {
  it("returns null without calling the wallet when it is unconfigured", async () => {
    setWalletChainOverride(null);
    const status = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const fake = {
      WALLET: { idFromName: () => "id", get: () => ({ status }) },
    } as unknown as Env;

    expect(await readWalletStatus(fake)).toBeNull();
    expect(status).not.toHaveBeenCalled();
  });

  it("returns null when a wallet read exceeds the timeout", async () => {
    useChain(new FakeChain());
    const fake = {
      WALLET: {
        idFromName: () => "id",
        get: () => ({
          status: () => new Promise<never>(() => {}),
        }),
      },
    } as unknown as Env;

    const started = Date.now();
    expect(await readWalletStatus(fake)).toBeNull();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(READ_TIMEOUT_MS - 250);
    expect(elapsed).toBeLessThan(READ_TIMEOUT_MS + 1_500);
  });
});
