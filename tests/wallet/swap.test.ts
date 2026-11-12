import { env, runInDurableObject } from "cloudflare:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import {
  CHAINS,
  erc20Abi,
  swapRouterAbi,
} from "../../src/wallet/chain";
import { GAS_RESERVE_WEI, UNMINED_AFTER_MS } from "../../src/wallet/guard";
import {
  setWalletChainOverride,
  type WalletNotice,
} from "../../src/wallet/wallet-do";
import { FakeChain } from "../helpers/fake-chain";
import { resetWallet } from "../helpers/wallet";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const START = Date.UTC(2030, 0, 1, 9, 0, 0);
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const USDC = CHAINS.base.tokens.USDC?.address as Address;
const ROUTER = CHAINS.base.router;

type TradeRow = {
  id: string;
  at: number;
  sell: string;
  buy: string;
  amount_in: string;
  min_out: string;
  value_before: number;
  value_after: number | null;
  tx_hash: Hex | null;
  nonce: number | null;
  raw: Hex | null;
  status: string;
  error: string | null;
};

let now = START;

function wallet() {
  return env.WALLET.get(env.WALLET.idFromName("global"));
}

function useChain(chain: FakeChain): FakeChain {
  setWalletChainOverride({ chain, owner: OWNER });
  return chain;
}

function funded(chain: FakeChain, usdc = 1_000_000_000n): FakeChain {
  chain.balances.USDC = usdc;
  chain.ethWei = GAS_RESERVE_WEI;
  chain.usdPrice = { WETH: 2000, cbBTC: 60_000 };
  return chain;
}

function allow(chain: FakeChain, amount = 100_000_000n): void {
  chain.allowances.set(
    `USDC:${ROUTER.toLowerCase()}`,
    amount,
  );
}

async function tradeRows(): Promise<TradeRow[]> {
  return runInDurableObject(wallet(), (_instance, state) =>
    state.storage.sql
      .exec<TradeRow>(
        `SELECT id, at, sell, buy, amount_in, min_out, value_before,
                value_after, tx_hash, nonce, raw, status, error
         FROM trades ORDER BY rowid`,
      )
      .toArray(),
  );
}

async function insertPendingRemit(id: string, at: number): Promise<void> {
  await runInDurableObject(wallet(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO remittances
        (id, at, usdc, reason, tx_hash, nonce, raw, status, settled_at, error)
       VALUES (?, ?, '10000000', 'seeded', ?, 0, NULL, 'pending', NULL, NULL)`,
      id,
      at,
      "0x" + "ab".repeat(32),
    );
  });
}

async function insertConfirmedTrade(row: {
  id: string;
  at: number;
  valueBefore: number;
  valueAfter: number | null;
}): Promise<void> {
  await runInDurableObject(wallet(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO trades
        (id, at, sell, buy, amount_in, min_out, value_before, value_after,
         tx_hash, nonce, raw, status, error)
       VALUES (?, ?, 'USDC', 'WETH', '1000000', '0', ?, ?, NULL, NULL, NULL,
               'confirmed', NULL)`,
      row.id,
      row.at,
      row.valueBefore,
      row.valueAfter,
    );
  });
}

async function insertConfirmedRemit(id: string, at: number): Promise<void> {
  await runInDurableObject(wallet(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO remittances
        (id, at, usdc, reason, tx_hash, nonce, raw, status, settled_at, error)
       VALUES (?, ?, '10000000', 'seeded', NULL, NULL, NULL, 'confirmed', NULL,
               NULL)`,
      id,
      at,
    );
  });
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

function decodeApprove(tx: { data: Hex }): {
  spender: Address;
  amount: bigint;
} {
  const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
  const [spender, amount] = decoded.args as readonly [Address, bigint];
  return { spender, amount };
}

function decodeSwap(tx: { data: Hex }): {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
} {
  const decoded = decodeFunctionData({ abi: swapRouterAbi, data: tx.data });
  return (
    decoded.args as readonly [
      {
        tokenIn: Address;
        tokenOut: Address;
        fee: number;
        recipient: Address;
        amountIn: bigint;
        amountOutMinimum: bigint;
      },
    ]
  )[0];
}

function isSwap(tx: { to: Address }): boolean {
  return tx.to.toLowerCase() === ROUTER.toLowerCase();
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

describe("WalletDO swap", () => {
  it("approves the router, then swaps into the wallet itself", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);

    const result = await wallet().swap("USDC", "WETH", "100");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an ok swap");
    expect(result.amountOut).toBe("50000000000000000");
    expect(chain.sent).toHaveLength(2);

    expect(chain.sent[0].to.toLowerCase()).toBe(USDC.toLowerCase());
    const approve = decodeApprove(chain.sent[0]);
    expect(approve.spender.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(approve.amount).toBe(100_000_000n);

    expect(chain.sent[1].to.toLowerCase()).toBe(ROUTER.toLowerCase());
    const swap = decodeSwap(chain.sent[1]);
    expect(swap.tokenIn.toLowerCase()).toBe(USDC.toLowerCase());
    expect(swap.tokenOut.toLowerCase()).toBe(
      CHAINS.base.tokens.WETH?.address.toLowerCase(),
    );
    expect(swap.recipient.toLowerCase()).toBe(chain.address.toLowerCase());
    expect(swap.amountIn).toBe(100_000_000n);
    expect(swap.amountOutMinimum).toBe(49_500_000_000_000_000n);
    expect(swap.fee).toBe(3000);

    const rows = await tradeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sell: "USDC",
      buy: "WETH",
      status: "confirmed",
    });
    expect(rows[0].value_after).not.toBeNull();
    expect(result.valueAfter).toBe(rows[0].value_after);
  });

  it("does not approve again when the allowance covers the swap", async () => {
    const chain = funded(new FakeChain());
    allow(chain);
    useChain(chain);

    const result = await wallet().swap("USDC", "WETH", "100");

    expect(result.ok).toBe(true);
    expect(chain.sent).toHaveLength(1);
    expect(isSwap(chain.sent[0])).toBe(true);
  });

  it("does not sign a swap when the approve reverts", async () => {
    const chain = funded(new FakeChain());
    chain.defaultReceipt = { status: "reverted", gasWei: 0n };
    useChain(chain);

    const result = await wallet().swap("USDC", "WETH", "100");

    expect(result).toMatchObject({
      ok: false,
      reason: "wallet.swap.approve",
      inFlight: false,
    });
    expect(chain.sent).toHaveLength(1);
    expect(isSwap(chain.sent[0])).toBe(false);
    expect(await tradeRows()).toHaveLength(0);
  });

  it("does not sign a swap when the approve times out", async () => {
    const chain = funded(new FakeChain());
    chain.receipt = async () => null;
    useChain(chain);

    const result = await wallet().swap("USDC", "WETH", "100");

    expect(result).toMatchObject({
      ok: false,
      reason: "wallet.swap.approve",
      inFlight: false,
    });
    expect(chain.sent).toHaveLength(1);
    expect(await tradeRows()).toHaveLength(0);
  });

  it("keeps one swap in flight when the broadcast throws after it landed", async () => {
    const chain = funded(new FakeChain());
    allow(chain);
    chain.broadcastMode = "throw-mined";
    useChain(chain);

    const first = await wallet().swap("USDC", "WETH", "100");

    expect(first).toMatchObject({
      ok: false,
      reason: "wallet.swap.inFlight",
      inFlight: true,
    });
    let rows = await tradeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].tx_hash).not.toBeNull();

    chain.broadcastMode = "ok";
    await wallet().remit(10, "settle");

    rows = await tradeRows();
    expect(rows[0].status).toBe("confirmed");
    expect(rows[0].value_after).not.toBeNull();
    expect(chain.sent.filter(isSwap)).toHaveLength(1);
  });

  it("blocks a swap while a remittance is pending", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);
    await insertPendingRemit("rem-pending", now);

    const result = await wallet().swap("USDC", "WETH", "100");

    expect(result).toMatchObject({
      ok: false,
      reason: "wallet.swap.busy",
      inFlight: true,
    });
    expect(chain.sent).toHaveLength(0);
  });

  it("serializes concurrent swaps", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);

    const [first, second] = await Promise.all([
      wallet().swap("USDC", "WETH", "100"),
      wallet().swap("USDC", "WETH", "100"),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok) throw new Error("expected the first swap to succeed");

    // Nothing from the second swap may be signed before the first swap has
    // been mined. The first call signs exactly an approve and a swap, so a
    // longer prefix means the two calls interleaved.
    const firstSwapReceipt = chain.calls.indexOf(`receipt:${first.txHash}`);
    expect(firstSwapReceipt).toBeGreaterThanOrEqual(0);
    const signsBeforeFirstSwap = chain.calls
      .slice(0, firstSwapReceipt)
      .filter((call) => call === "sign").length;
    expect(signsBeforeFirstSwap).toBe(2);
  });

  it("notices a stuck swap with its own kind", async () => {
    const chain = funded(new FakeChain());
    allow(chain);
    chain.broadcastMode = "throw-unmined";
    useChain(chain);
    const notices = await stubNotices();

    const first = await wallet().swap("USDC", "WETH", "100");
    expect(first).toMatchObject({ ok: false, inFlight: true });

    now = START + UNMINED_AFTER_MS + 1;
    const blocked = await wallet().swap("USDC", "WETH", "100");

    expect(blocked).toMatchObject({
      ok: false,
      reason: "wallet.swap.busy",
      inFlight: true,
    });
    expect(notices).toEqual([
      {
        kind: "wallet.tradeStuck",
        reason: "wallet.notice.tradeStuck",
        body: "",
      },
    ]);
  });
});

describe("WalletDO breaker", () => {
  it("refuses a swap at exactly ten percent realized loss, then resumes", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);
    await insertConfirmedTrade({
      id: "loss-1",
      at: now - 2_000,
      valueBefore: 500,
      valueAfter: 450,
    });
    await insertConfirmedTrade({
      id: "loss-2",
      at: now - 1_000,
      valueBefore: 500,
      valueAfter: 450,
    });

    const status = await wallet().status();
    expect(status.breaker).toEqual({ tripped: true, lossUsd: 100 });

    const blocked = await wallet().swap("USDC", "WETH", "100");
    expect(blocked).toMatchObject({
      ok: false,
      refusal: "breaker",
      reason: "wallet.refusal.breaker",
      inFlight: false,
    });
    expect(chain.sent).toHaveLength(0);

    await wallet().resumeTrading();
    const resumed = await wallet().swap("USDC", "WETH", "100");
    expect(resumed.ok).toBe(true);
  });

  it("clears the breaker at the next UTC midnight", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);
    await insertConfirmedTrade({
      id: "loss-1",
      at: now - 1_000,
      valueBefore: 1_000,
      valueAfter: 900,
    });

    now = START + 15 * 3_600_000 + 60_000; // next day, 00:01 UTC
    const result = await wallet().swap("USDC", "WETH", "100");

    expect(result.ok).toBe(true);
  });

  it("never blocks a remittance on the breaker", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);
    await insertConfirmedTrade({
      id: "loss-1",
      at: now - 1_000,
      valueBefore: 1_000,
      valueAfter: 900,
    });

    const result = await wallet().remit(10, "x");

    expect(result.ok).toBe(true);
  });

  it("refuses swaps until a missing value_after is backfilled", async () => {
    const chain = funded(new FakeChain());
    let failOnce = true;
    chain.onMined = (tx) => {
      if (failOnce && isSwap(tx)) {
        failOnce = false;
        chain.tokenBalanceError = new Error("rpc");
      }
    };
    useChain(chain);

    const first = await wallet().swap("USDC", "WETH", "100");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected an ok swap");
    expect(first.valueAfter).toBeNull();
    let rows = await tradeRows();
    expect(rows[0].value_after).toBeNull();
    chain.tokenBalanceError = null;
    expect((await wallet().status()).breaker.tripped).toBe(true);

    // Keep the value read broken so reconciliation cannot backfill it yet.
    chain.tokenBalanceError = new Error("rpc");
    const blocked = await wallet().swap("USDC", "WETH", "100");
    expect(blocked).toMatchObject({
      ok: false,
      refusal: "breaker",
      reason: "wallet.refusal.breaker",
      inFlight: false,
    });

    chain.tokenBalanceError = null;
    const recovered = await wallet().swap("USDC", "WETH", "100");
    expect(recovered.ok).toBe(true);
    rows = await tradeRows();
    expect(rows.every((row) => row.value_after !== null)).toBe(true);
    expect((await wallet().status()).breaker.tripped).toBe(false);
  });
});

describe("WalletDO history", () => {
  it("merges swaps and remittances newest first without raw data", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);
    await insertConfirmedRemit("rem-1", now - 1_000);
    await insertConfirmedTrade({
      id: "trade-1",
      at: now - 500,
      valueBefore: 500,
      valueAfter: 490,
    });

    const history = await wallet().history(10);

    expect(history.map((row) => row.kind)).toEqual(["swap", "remit"]);
    expect(history[0]).toMatchObject({
      kind: "swap",
      id: "trade-1",
      status: "confirmed",
      sell: "USDC",
      buy: "WETH",
      amount: "1000000",
      valueDeltaUsd: -10,
      txHash: null,
    });
    expect(history[1]).toMatchObject({
      kind: "remit",
      id: "rem-1",
      status: "confirmed",
      amount: "10000000",
      valueDeltaUsd: null,
      txHash: null,
    });
    expect(JSON.stringify(history)).not.toContain("raw");
    expect(JSON.stringify(history)).not.toContain("error");
  });

  it("clamps the limit to fifty rows", async () => {
    const chain = funded(new FakeChain());
    useChain(chain);
    for (let i = 0; i < 55; i += 1) {
      await insertConfirmedRemit(`rem-${i}`, now - i * 1_000);
    }

    expect(await wallet().history(500)).toHaveLength(50);
  });
});
