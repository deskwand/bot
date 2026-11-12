import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import { MAX_PRICE_HOURS, PRICE_KEEP_MS } from "../../src/wallet/guard";
import {
  setWalletChainOverride,
  type WalletNotice,
} from "../../src/wallet/wallet-do";
import { FakeChain } from "../helpers/fake-chain";
import { resetWallet } from "../helpers/wallet";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
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

async function alarmAt(): Promise<number | null> {
  return runInDurableObject(wallet(), (_instance, state) =>
    state.storage.getAlarm(),
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

type PriceRow = { hour: number; token: string; usd: number };

async function priceRows(): Promise<PriceRow[]> {
  return runInDurableObject(wallet(), (_instance, state) =>
    state.storage.sql
      .exec<PriceRow>(`SELECT hour, token, usd FROM prices ORDER BY hour, token`)
      .toArray(),
  );
}

async function insertPrice(hour: number, token: string, usd: number) {
  await runInDurableObject(wallet(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO prices (hour, token, usd) VALUES (?, ?, ?)`,
      hour,
      token,
      usd,
    );
  });
}

async function insertPendingTrade(id: string, at: number): Promise<void> {
  await runInDurableObject(wallet(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO trades
        (id, at, sell, buy, amount_in, min_out, value_before, value_after,
         tx_hash, nonce, raw, status, error)
       VALUES (?, ?, 'USDC', 'WETH', '1000000', '0', 100, NULL, ?, 0, NULL,
               'pending', NULL)`,
      id,
      at,
      "0x" + "ab".repeat(32),
    );
  });
}

function priced(): FakeChain {
  const chain = new FakeChain();
  chain.usdPrice = { WETH: 2000, cbBTC: 50_000 };
  return chain;
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

describe("WalletDO price sampling", () => {
  it("samples both whitelisted tokens once an alarm runs", async () => {
    const chain = useChain(priced());
    await wallet().ensureAlarm();

    expect(await runDurableObjectAlarm(wallet())).toBe(true);

    const hour = Math.floor(START / HOUR_MS);
    const rows = await priceRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.token === "WETH")).toEqual([
      { hour, token: "WETH", usd: 2000 },
    ]);
    expect(rows.find((row) => row.token === "cbBTC")?.usd).toBeCloseTo(
      50_000,
      6,
    );

    const series = await wallet().prices(24);
    expect(series.map((entry) => entry.token)).toEqual(["WETH", "cbBTC"]);
    expect(series[0]?.points).toEqual([{ at: hour * HOUR_MS, usd: 2000 }]);
    expect(chain.quoteCalls).toEqual(["USDC/WETH", "USDC/cbBTC"]);
  });

  it("does not sample twice in the same hour", async () => {
    const chain = useChain(priced());
    await wallet().ensureAlarm();
    await runDurableObjectAlarm(wallet());
    const calls = chain.quoteCalls.length;

    await runDurableObjectAlarm(wallet());

    expect(chain.quoteCalls.length).toBe(calls);
    expect(await priceRows()).toHaveLength(2);
  });

  it("drops rows older than the retention window", async () => {
    const chain = useChain(priced());
    await wallet().ensureAlarm();
    await runDurableObjectAlarm(wallet());

    const hour = Math.floor(START / HOUR_MS);
    const old = hour - Math.ceil((31 * DAY_MS) / HOUR_MS);
    await insertPrice(old, "WETH", 1);

    now = START + HOUR_MS;
    await runDurableObjectAlarm(wallet());

    const hours = (await priceRows()).map((row) => row.hour);
    expect(hours).not.toContain(old);
    expect(hours).toContain(hour);
    expect(hours).toContain(hour + 1);
    expect(PRICE_KEEP_MS).toBe(30 * DAY_MS);
    expect(chain.quoteCalls.length).toBeGreaterThan(0);
  });

  it("keeps the other token when one price probe fails", async () => {
    const chain = useChain(priced());
    const original = chain.quote.bind(chain);
    chain.quote = async (sell, buy, amountIn) => {
      if (buy === "WETH") throw new Error("rpc");
      return original(sell, buy, amountIn);
    };
    await wallet().ensureAlarm();

    await expect(runDurableObjectAlarm(wallet())).resolves.toBe(true);

    const rows = await priceRows();
    expect(rows.map((row) => row.token)).toEqual(["cbBTC"]);
  });

  it("reconciles a pending trade before sampling and retries in five minutes", async () => {
    const chain = useChain(priced());
    await insertPendingTrade("trade-1", now);
    await wallet().ensureAlarm();

    await runDurableObjectAlarm(wallet());

    const receipt = chain.calls.findIndex((call) =>
      call.startsWith("receipt:"),
    );
    const quote = chain.calls.findIndex((call) => call === "quote:USDC/WETH");
    expect(receipt).toBeGreaterThanOrEqual(0);
    expect(quote).toBeGreaterThan(receipt);
    expect(await priceRows()).toHaveLength(2);
    expect(await alarmAt()).toBe(START + 5 * 60_000);
  });

  it("clamps the history window to the maximum", async () => {
    useChain(priced());
    const hour = Math.floor(START / HOUR_MS);
    await insertPrice(hour - 200, "WETH", 100);
    await insertPrice(hour - 10, "WETH", 2000);

    const series = await wallet().prices(500);

    expect(series[0]?.points.map((point) => point.at)).toEqual([
      (hour - 10) * HOUR_MS,
    ]);
    expect(MAX_PRICE_HOURS).toBe(168);
  });
});

describe("WalletDO depleted notice", () => {
  it("stays quiet when the owner never funded the wallet", async () => {
    useChain(priced());
    const notices = await stubNotices();
    await wallet().ensureAlarm();

    await runDurableObjectAlarm(wallet());

    expect(notices).toEqual([]);
  });

  it("notices once each time the value falls below five dollars", async () => {
    const chain = useChain(priced());
    const notices = await stubNotices();

    chain.balances.USDC = 10_000_000n;
    await wallet().ensureAlarm();
    await runDurableObjectAlarm(wallet());
    expect(notices).toEqual([]);

    chain.balances.USDC = 3_000_000n;
    now += HOUR_MS;
    await runDurableObjectAlarm(wallet());
    expect(notices).toEqual([
      { kind: "wallet.depleted", valueUsd: 3, body: "" },
    ]);

    now += HOUR_MS;
    await runDurableObjectAlarm(wallet());
    expect(notices).toHaveLength(1);

    chain.balances.USDC = 10_000_000n;
    now += HOUR_MS;
    await runDurableObjectAlarm(wallet());

    chain.balances.USDC = 3_000_000n;
    now += HOUR_MS;
    await runDurableObjectAlarm(wallet());
    expect(notices).toHaveLength(2);
    expect(notices[1]).toEqual({
      kind: "wallet.depleted",
      valueUsd: 3,
      body: "",
    });
  });

  it("stays quiet after a remittance empties a previously funded wallet", async () => {
    const chain = useChain(priced());
    const notices = await stubNotices();

    chain.balances.USDC = 10_000_000n;
    await wallet().ensureAlarm();
    await runDurableObjectAlarm(wallet());
    expect(notices).toEqual([]);

    const remit = await wallet().remit(8, "buffer");
    expect(remit.ok).toBe(true);
    chain.balances.USDC = 2_000_000n;
    now += HOUR_MS;
    await runDurableObjectAlarm(wallet());
    expect(notices).toEqual([]);

    chain.balances.USDC = 10_000_000n;
    now += HOUR_MS;
    await runDurableObjectAlarm(wallet());

    chain.balances.USDC = 3_000_000n;
    now += HOUR_MS;
    await runDurableObjectAlarm(wallet());
    expect(notices).toEqual([
      { kind: "wallet.depleted", valueUsd: 3, body: "" },
    ]);
  });

  it("stays quiet when reconciliation confirms the emptying remittance", async () => {
    const chain = useChain(priced());
    const notices = await stubNotices();

    chain.balances.USDC = 10_000_000n;
    await wallet().ensureAlarm();
    await runDurableObjectAlarm(wallet());

    chain.broadcastMode = "throw-mined";
    const remit = await wallet().remit(8, "buffer");
    expect(remit).toMatchObject({ ok: false, inFlight: true });

    chain.broadcastMode = "ok";
    chain.balances.USDC = 2_000_000n;
    now += HOUR_MS;
    await runDurableObjectAlarm(wallet());

    expect(
      notices.filter((notice) => notice.kind === "wallet.depleted"),
    ).toEqual([]);
  });

  it("skips the check when holdings cannot be read", async () => {
    const chain = useChain(priced());
    const notices = await stubNotices();
    chain.balances.USDC = 10_000_000n;
    await wallet().ensureAlarm();
    await runDurableObjectAlarm(wallet());

    chain.balances.USDC = 3_000_000n;
    chain.tokenBalanceError = new Error("rpc");
    now += HOUR_MS;
    await expect(runDurableObjectAlarm(wallet())).resolves.toBe(true);

    expect(notices).toEqual([]);
  });
});

describe("WalletDO ensureAlarm", () => {
  it("does nothing while the wallet is unconfigured", async () => {
    setWalletChainOverride(null);

    await wallet().ensureAlarm();

    expect(await alarmAt()).toBeNull();
  });

  it("sets the alarm for the next whole hour when none exists", async () => {
    useChain(priced());

    await wallet().ensureAlarm();

    expect(await alarmAt()).toBe(START + HOUR_MS);
  });

  it("keeps an earlier alarm instead of pushing it back", async () => {
    useChain(priced());
    const earlier = START + 60_000;
    await runInDurableObject(wallet(), (_instance, state) =>
      state.storage.setAlarm(earlier),
    );

    await wallet().ensureAlarm();

    expect(await alarmAt()).toBe(earlier);
  });
});
