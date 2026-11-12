import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setBotButlerOverride,
  type BotButler,
  type SpawnForBotResult,
} from "../../src/bot/bot-do";
import { BotStore, type BotMeta } from "../../src/bot/bot-store";
import { DIET_RECHECK_MS, WATCHDOG_MS } from "../../src/bot/wake";
import { BotsRepo } from "../../src/butler/bots-repo";
import {
  createBotTools,
  type TaskControl,
} from "../../src/butler/bot-tools";
import { setClockOverride } from "../../src/butler/notifier";
import { t } from "../../src/i18n";
import type { SpendEntry } from "../../src/life/books";
import { lifeStub } from "../../src/life/client";
import { CHAINS } from "../../src/wallet/chain";
import {
  createEarnerTools,
  createWalletResumeTool,
} from "../../src/wallet/tools";
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

const START = Date.UTC(2030, 0, 1, 9, 0, 0);
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const BUTLER = "earner-e2e";

let now = START;
let notices: WalletNotice[] = [];
let spawns: string[] = [];
let script: (() => Promise<void>) | null = null;
let taskCounter = 0;

type ToolOutcome = {
  output?: { type: string; text?: string }[];
  isError?: boolean;
};

type TradeRow = {
  id: string;
  status: string;
  value_before: number;
  value_after: number | null;
};

function text(outcome: ToolOutcome): string {
  return (outcome.output?.[0] as { text: string }).text;
}

function life() {
  return lifeStub(env);
}

function wallet() {
  return walletStub(env);
}

function butler() {
  return env.BUTLER.get(env.BUTLER.idFromName(BUTLER));
}

function botStub(id: string) {
  return env.BOT.get(env.BOT.idFromName(id));
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

function earnerTools(): ToolRegistration[] {
  return createEarnerTools({
    wallet: () => walletStub(env),
    locale: "zh",
  });
}

async function runEarner(
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const tool = earnerTools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(args as never, {} as never, {} as never);
}

async function resumeTrading(): Promise<ToolOutcome> {
  return createWalletResumeTool({
    resume: () => wallet().resumeTrading(),
    locale: "zh",
  }).execute({} as never, {} as never, {} as never);
}

function fakeTask(): TaskControl {
  return {
    start: async () => {},
    status: async () => ({ state: "running", title: "" }),
    steer: async () => ({ ok: true, message: "" }),
    cancel: async () => ({ ok: true, message: "" }),
    retryTask: async () => ({ ok: true, message: "" }),
    liveness: async () => ({
      state: "running",
      reattached: false,
    }),
    pendingApprovals: async () => [],
  };
}

/** Creates a bot through the Butler's own create_bot tool. */
async function createBot(args: Record<string, unknown>): Promise<{
  text: string;
  isError: boolean;
}> {
  return runInDurableObject(butler(), async (_instance, state) => {
    const bots = new BotsRepo(state.storage.sql);
    const tools = createBotTools({
      bots,
      bot: (id) => botStub(id),
      botChat: () => ({
        destroy: async () => {},
        ask: async () => "",
      }),
      task: () => fakeTask(),
      walletConfigured: true,
      locale: "zh",
    });
    const tool = tools.find((candidate) => candidate.name === "create_bot");
    if (!tool) throw new Error("missing tool create_bot");
    const outcome = (await tool.execute(
      args as never,
      {} as never,
      {} as never,
    )) as ToolOutcome;
    return { text: text(outcome), isError: outcome.isError === true };
  });
}

/** Stores a script the next earner wake runs through its installed tools. */
function fakeButler(earnerId: string): void {
  const butlerStub: BotButler = {
    async spawnForBot(botId): Promise<SpawnForBotResult> {
      spawns.push(botId);
      taskCounter += 1;
      if (botId === earnerId && script !== null) await script();
      return { ok: true, taskId: `task-${taskCounter}` };
    },
    async botTaskOutcome() {
      return { outcome: "completed" as const, summary: "" };
    },
    async botNotice() {},
    async ownerProfile() {
      return "";
    },
    async maintenanceActive() {
      return false;
    },
  };
  setBotButlerOverride(butlerStub);
}

async function patchMeta(
  bot: ReturnType<typeof botStub>,
  patch: Partial<BotMeta>,
): Promise<void> {
  await runInDurableObject(bot, (_instance, state) => {
    const store = new BotStore(state.storage.sql);
    const meta = store.readMeta();
    if (meta !== null) store.writeMeta({ ...meta, ...patch });
  });
}

/** Runs one bot wake; a spawned run is immediately reported as completed. */
async function wake(
  bot: ReturnType<typeof botStub>,
  expectSpawn: boolean,
): Promise<void> {
  const before = spawns.length;
  await patchMeta(bot, { nextWakeAt: now });
  expect(await runDurableObjectAlarm(bot)).toBe(true);
  if (!expectSpawn) {
    expect(spawns.length).toBe(before);
    return;
  }
  expect(spawns.length).toBe(before + 1);
  now += WATCHDOG_MS;
  expect(await runDurableObjectAlarm(bot)).toBe(true);
  expect((await bot.snapshot())?.meta.currentTaskId).toBeNull();
}

async function tradeRows(): Promise<TradeRow[]> {
  return runInDurableObject(wallet(), (_instance, state) =>
    state.storage.sql
      .exec<TradeRow>(
        `SELECT id, status, value_before, value_after FROM trades ORDER BY at, rowid`,
      )
      .toArray(),
  );
}

async function kvValue<T>(key: string): Promise<T | undefined> {
  return runInDurableObject(wallet(), (_instance, state) =>
    state.storage.kv.get<T>(key),
  );
}

function nextWake(bot: ReturnType<typeof botStub>): Promise<number | null> {
  return bot.snapshot().then((snapshot) => snapshot?.meta.nextWakeAt ?? null);
}

beforeEach(async () => {
  now = START;
  spawns = [];
  script = null;
  taskCounter = 0;
  notices = [];
  setClockOverride({
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  setWalletChainOverride(null);
  setBotButlerOverride(null);
  await resetLife();
  await resetWallet();
});

afterEach(async () => {
  setWalletChainOverride(null);
  setBotButlerOverride(null);
  setClockOverride(null);
  await resetLife();
  await resetWallet();
});

describe("earner bot lifecycle end to end", () => {
  it("trades, refuses, trips and lifts the breaker, survives critical, then stops when depleted", async () => {
    const chain = new FakeChain();
    chain.balances.USDC = 100_000_000n;
    chain.ethWei = 10_000_000_000_000_000n;
    chain.usdPrice = { WETH: 3000 };
    setWalletChainOverride({ chain, owner: OWNER });
    await runInDurableObject(wallet(), (instance) => {
      instance.notifyOwner = async (event) => {
        notices.push(event);
      };
    });
    expect(walletConfigured(env)).toBe(true);

    // 1. The Butler creates the one earner and an ordinary bot beside it.
    const created = await createBot({
      name: "谋生机器人",
      mission: "让钱包慢慢变多",
      default_interval: "4h",
      earner: true,
    });
    expect(created.text).toContain("已创建机器人");
    const earnerId = created.text.split(" ")[1] as string;
    const ordinary = await createBot({
      name: "普通哨兵",
      mission: "盯着价格",
      default_interval: "4h",
    });
    expect(ordinary.text).toContain("已创建机器人");
    const ordinaryId = ordinary.text.split(" ")[1] as string;
    fakeButler(earnerId);

    const earner = (await botStub(earnerId).snapshot())!;
    expect(earner.meta.earner).toBe(true);
    expect(earner.docs).toContainEqual({
      name: "守则",
      content: t("zh", "wallet.earner.defaultRules"),
    });

    // 2. First wake: read prices, then swap a compliant 20 USDC into WETH.
    let pricesText = "";
    let firstSwap: ToolOutcome | null = null;
    script = async () => {
      pricesText = text(await runEarner("market_prices"));
      firstSwap = await runEarner("wallet_swap", {
        sell: "USDC",
        buy: "WETH",
        amount: "20",
      });
    };
    await wake(botStub(earnerId), true);
    expect(pricesText).toContain("行情");
    expect(firstSwap!.isError).toBeUndefined();
    expect(text(firstSwap!)).toContain("换币成功");
    expect(chain.balances.USDC).toBe(80_000_000n);
    expect(chain.balances.WETH).toBeGreaterThan(0n);

    const firstRows = await tradeRows();
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]).toMatchObject({ status: "confirmed" });
    expect(firstRows[0]!.value_after).not.toBeNull();

    // The alarm marks the wallet as funded so a later drop can notify.
    await wallet().ensureAlarm();
    expect(await runDurableObjectAlarm(wallet())).toBe(true);
    expect(await kvValue<boolean>("funded")).toBe(true);

    // 3. A 40 USDC trade is over 25% of the value and is refused.
    const tooLarge = await runEarner("wallet_swap", {
      sell: "USDC",
      buy: "WETH",
      amount: "40",
    });
    expect(tooLarge.isError).toBe(true);
    expect(text(tooLarge)).toBe(t("zh", "wallet.refusal.too_large"));
    expect(await tradeRows()).toHaveLength(1);

    // 4. A second swap is mined after WETH falls, realizing a 10% loss.
    chain.onMined = (tx) => {
      if (tx.to.toLowerCase() === CHAINS.base.router.toLowerCase()) {
        chain.usdPrice = { ...chain.usdPrice, WETH: 2250 };
      }
    };
    let secondSwap: ToolOutcome | null = null;
    script = async () => {
      secondSwap = await runEarner("wallet_swap", {
        sell: "USDC",
        buy: "WETH",
        amount: "20",
      });
    };
    await wake(botStub(earnerId), true);
    expect(secondSwap!.isError).toBeUndefined();

    const lossRows = await tradeRows();
    expect(lossRows).toHaveLength(2);
    const loss = lossRows.reduce(
      (sum, row) => sum + Math.max(0, row.value_before - (row.value_after ?? 0)),
      0,
    );
    const afterLoss = await wallet().status();
    expect(afterLoss.breaker.tripped).toBe(true);
    expect(loss * 10).toBeGreaterThanOrEqual(afterLoss.holdings.valueUsd);

    const breakerSwap = await runEarner("wallet_swap", {
      sell: "USDC",
      buy: "WETH",
      amount: "10",
    });
    expect(breakerSwap.isError).toBe(true);
    expect(text(breakerSwap)).toBe(t("zh", "wallet.refusal.breaker"));
    expect(await tradeRows()).toHaveLength(2);

    // The owner lifts the breaker; the same trade now goes through.
    now += 60_000;
    const resumed = await resumeTrading();
    expect(text(resumed)).toBe(t("zh", "wallet.resume.done"));
    expect((await wallet().status()).breaker.tripped).toBe(false);
    const afterResume = await runEarner("wallet_swap", {
      sell: "USDC",
      buy: "WETH",
      amount: "10",
    });
    expect(afterResume.isError).toBeUndefined();
    expect(await tradeRows()).toHaveLength(3);

    // 5. Critical: the earner wakes anyway; the ordinary bot is held.
    await life().recordCredit(20, "");
    await life().recordSpend(entry(15));
    expect((await life().vitals()).tier).toBe("critical");
    script = async () => {};
    await wake(botStub(earnerId), true);
    const ordinaryBefore = spawns.length;
    await wake(botStub(ordinaryId), false);
    expect(spawns.length).toBe(ordinaryBefore);
    expect(await nextWake(botStub(ordinaryId))).toBe(now + DIET_RECHECK_MS);

    // Dormant: even the earner is held.
    await life().recordSpend(entry(5));
    expect((await life().vitals()).tier).toBe("dormant");
    const dormantBefore = spawns.length;
    await wake(botStub(earnerId), false);
    expect(spawns.length).toBe(dormantBefore);
    expect(await nextWake(botStub(earnerId))).toBe(now + DIET_RECHECK_MS);

    // The tier change above may have triggered an auto remittance, which
    // clears the funded flag. A wallet above the floor arms the notice again.
    chain.balances.USDC = 10_000_000n;
    chain.balances.WETH = 0n;
    await wallet().ensureAlarm();
    await runDurableObjectAlarm(wallet());

    // 6. Value falls under $5: one depleted notice, and no more swaps.
    chain.balances.USDC = 3_000_000n;
    chain.balances.WETH = 0n;
    expect(await runDurableObjectAlarm(wallet())).toBe(true);
    expect(
      notices.filter((notice) => notice.kind === "wallet.depleted"),
    ).toHaveLength(1);
    expect(await runDurableObjectAlarm(wallet())).toBe(true);
    expect(
      notices.filter((notice) => notice.kind === "wallet.depleted"),
    ).toHaveLength(1);

    const depleted = await runEarner("wallet_swap", {
      sell: "USDC",
      buy: "WETH",
      amount: "1",
    });
    expect(depleted.isError).toBe(true);
    expect(text(depleted)).toBe(t("zh", "wallet.refusal.depleted"));
  });
});
