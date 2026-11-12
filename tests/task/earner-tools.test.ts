import { env, runInDurableObject } from "cloudflare:test";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import type { TaskSpec } from "../../src/protocol";
import { setWalletChainOverride } from "../../src/wallet/wallet-do";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { FakeChain } from "../helpers/fake-chain";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const EARNER_TOOLS = [
  "wallet_balances",
  "market_prices",
  "wallet_swap",
  "wallet_history",
];

beforeEach(async () => {
  setChannelOverride("telegram", fakeChannel().adapter);
  await seedOwnerAddress("42");
});

afterEach(() => {
  setWalletChainOverride(null);
  setModelOverride(null);
  setChannelOverride("telegram", null);
  vi.restoreAllMocks();
});

function botStub(id: string) {
  return env.BOT.get(env.BOT.idFromName(id));
}

/** Creates the bot's own DO, which TaskDO reads to decide on wallet tools. */
async function initBot(id: string, earner: boolean): Promise<void> {
  await botStub(id).init({
    botId: id,
    name: id,
    mission: "trade",
    defaultIntervalMs: 4 * 3_600_000,
    firstWakeAt: Date.now() + 3_600_000,
    ...(earner ? { earner: true } : {}),
  });
}

/** Starts one bot run with a scripted model and returns its tool names. */
async function startAndList(taskId: string, botId: string): Promise<string[]> {
  setModelOverride(
    scriptedModel([
      { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
    ]),
  );
  const stub = env.TASK.get(env.TASK.idFromName(taskId));
  const spec: TaskSpec = {
    taskId,
    title: taskId,
    instructions: "decide whether to trade",
    botId,
  };

  await stub.start(spec);

  // Let the run's outbox reach the Butler before the channel override is torn
  // down; otherwise the completion notice races with the next test file.
  await vi.waitFor(
    async () => {
      const events = await env.BUTLER.get(
        env.BUTLER.idFromName("owner"),
      ).debugEvents(taskId);
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "completed",
      ]);
    },
    { timeout: 10_000 },
  );

  return runInDurableObject(stub, (instance) =>
    instance.registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool.name),
  );
}

describe("TaskDO earner wallet tools", () => {
  it("gives an earner bot the four wallet tools", async () => {
    setWalletChainOverride({ chain: new FakeChain(), owner: OWNER });
    await initBot("earner-a", true);

    const names = await startAndList("t-earner-a", "earner-a");

    expect(names).toEqual(expect.arrayContaining(EARNER_TOOLS));
  });

  it("gives an ordinary bot no wallet tools", async () => {
    setWalletChainOverride({ chain: new FakeChain(), owner: OWNER });
    await initBot("plain-a", false);

    const names = await startAndList("t-plain-a", "plain-a");

    expect(names.filter((name) => name.startsWith("wallet_"))).toEqual([]);
  });

  it("gives an earner bot no wallet tools when the wallet is unconfigured", async () => {
    await initBot("earner-b", true);

    const names = await startAndList("t-earner-b", "earner-b");

    expect(names.filter((name) => name.startsWith("wallet_"))).toEqual([]);
  });
});
