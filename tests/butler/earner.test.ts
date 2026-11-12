import { env, runInDurableObject } from "cloudflare:test";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RULES_DOC, RULES_LIMIT } from "../../src/bot/docs";
import { BotsRepo } from "../../src/butler/bots-repo";
import type { BotControl } from "../../src/butler/bot-tools";
import {
  EARNER_INTERVAL_MS,
  ensureEarnerBot,
  type EnsureEarnerResult,
} from "../../src/butler/earner";
import { setClockOverride } from "../../src/butler/notifier";
import { t, type Locale } from "../../src/i18n";
import { setWalletChainOverride } from "../../src/wallet/wallet-do";
import { FakeChain } from "../helpers/fake-chain";
import { resetWallet } from "../helpers/wallet";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const START = Date.UTC(2030, 0, 1, 9, 0, 0);
const OWNER = "0x1111111111111111111111111111111111111111" as Address;

let now = START;

type Bot = Pick<BotControl, "init" | "snapshot" | "destroy">;

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function botStub(id: string) {
  return env.BOT.get(env.BOT.idFromName(id));
}

async function ensure(
  butlerName: string,
  walletConfigured = true,
  locale: Locale = "zh",
  bot: (id: string) => Bot = botStub,
  allowed?: () => boolean,
): Promise<EnsureEarnerResult> {
  return runInDurableObject(butler(butlerName), (_instance, state) =>
    ensureEarnerBot({
      bots: new BotsRepo(state.storage.sql),
      bot,
      walletConfigured,
      locale,
      ...(allowed === undefined ? {} : { allowed }),
    }),
  );
}

async function rows(butlerName: string) {
  return runInDurableObject(butler(butlerName), (_instance, state) =>
    new BotsRepo(state.storage.sql).list(),
  );
}

async function destroyBots(): Promise<void> {
  for (const id of ["b1", "b2", "b3"]) await botStub(id).destroy();
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
  await destroyBots();
});

afterEach(async () => {
  await destroyBots();
  setWalletChainOverride(null);
  setClockOverride(null);
  await resetWallet();
});

describe("ensureEarnerBot", () => {
  it("creates one earner when the wallet is configured", async () => {
    expect(await ensure("earner-create")).toBe("created");

    const list = await rows("earner-create");
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe(t("zh", "wallet.earner.name"));

    const snapshot = await botStub("b1").snapshot();
    expect(snapshot?.meta.earner).toBe(true);
    expect(snapshot?.meta.defaultIntervalMs).toBe(EARNER_INTERVAL_MS);
    expect(snapshot?.meta.nextWakeAt).toBe(now);
    expect(snapshot?.meta.mission).toBe(t("zh", "wallet.earner.mission"));
    expect(snapshot?.docs).toContainEqual({
      name: RULES_DOC,
      content: t("zh", "wallet.earner.rules"),
    });
  });

  it("does nothing a second time", async () => {
    expect(await ensure("earner-twice")).toBe("created");
    expect(await ensure("earner-twice")).toBe("exists");
    expect(await rows("earner-twice")).toHaveLength(1);
  });

  it("does nothing while the wallet is unconfigured", async () => {
    expect(await ensure("earner-unconfigured", false)).toBe("unconfigured");
    expect(await rows("earner-unconfigured")).toEqual([]);
  });

  it("leaves a paused earner paused", async () => {
    expect(await ensure("earner-paused")).toBe("created");
    await botStub("b1").pause();

    expect(await ensure("earner-paused")).toBe("exists");
    expect((await botStub("b1").snapshot())?.meta.status).toBe("paused");
  });

  it("counts a hand-made earner from P2", async () => {
    const butlerName = "earner-handmade";
    await runInDurableObject(butler(butlerName), (_instance, state) => {
      new BotsRepo(state.storage.sql).insert({ id: "b1", name: "旧谋生" });
    });
    await botStub("b1").init({
      botId: "b1",
      name: "旧谋生",
      mission: "旧使命",
      defaultIntervalMs: 3_600_000,
      firstWakeAt: now,
      earner: true,
    });

    expect(await ensure(butlerName)).toBe("exists");
    expect((await botStub("b1").snapshot())?.meta.mission).toBe("旧使命");
  });

  it("uses English copy for an English owner", async () => {
    expect(await ensure("earner-en", true, "en")).toBe("created");
    const list = await rows("earner-en");
    expect(list[0]!.name).toBe("Livelihood");
  });

  it("removes the row when init fails and the bot can be destroyed", async () => {
    const calls: string[] = [];
    const failing: Bot = {
      init: async () => {
        throw new Error("init failed");
      },
      snapshot: async () => null,
      destroy: async () => {
        calls.push("destroy");
      },
    };

    await expect(
      ensure("earner-rollback", true, "zh", () => failing),
    ).rejects.toThrow("init failed");
    expect(calls).toEqual(["destroy"]);
    expect(await rows("earner-rollback")).toEqual([]);
  });

  it("keeps the row when init and destroy both fail", async () => {
    const failing: Bot = {
      init: async () => {
        throw new Error("init failed");
      },
      snapshot: async () => null,
      destroy: async () => {
        throw new Error("destroy failed");
      },
    };

    await expect(
      ensure("earner-orphan", true, "zh", () => failing),
    ).rejects.toThrow("init failed");
    const list = await rows("earner-orphan");
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe(t("zh", "wallet.earner.name"));
  });

  it("refuses to create while not allowed", async () => {
    expect(
      await ensure("earner-not-allowed", true, "zh", botStub, () => false),
    ).toBe("busy");
    expect(await rows("earner-not-allowed")).toEqual([]);
  });

  it("re-checks permission after the scan", async () => {
    const butlerName = "earner-race";
    await runInDurableObject(butler(butlerName), (_instance, state) => {
      new BotsRepo(state.storage.sql).insert({ id: "b1", name: "旧机器人" });
    });
    let allowed = true;
    const bot: Bot = {
      init: async () => {},
      destroy: async () => {},
      snapshot: async () => {
        allowed = false;
        return null;
      },
    };

    expect(await ensure(butlerName, true, "zh", () => bot, () => allowed)).toBe(
      "busy",
    );
    const list = await rows(butlerName);
    expect(list.map((row) => row.id)).toEqual(["b1"]);
    expect(await botStub("b2").snapshot()).toBeNull();
  });

  it("keeps the earner copy within the rules limit", () => {
    for (const locale of ["zh", "en"] as const) {
      expect(
        t(locale, "wallet.earner.rules").length,
      ).toBeLessThanOrEqual(RULES_LIMIT);
      for (const key of [
        "wallet.earner.name",
        "wallet.earner.mission",
        "wallet.earner.undeletable",
      ] as const) {
        expect(t(locale, key).length).toBeGreaterThan(0);
        expect(t(locale, key)).not.toBe(key);
      }
    }
  });

  it("serialises concurrent calls into one earner", async () => {
    const chain = new FakeChain();
    chain.balances.USDC = 5_000_000n;
    setWalletChainOverride({ chain, owner: OWNER });
    const butlerName = "earner-concurrent";

    const results = await Promise.all([
      butler(butlerName).ensureEarner(),
      butler(butlerName).ensureEarner(),
    ]);

    expect(results).toEqual(["created", "created"]);
    expect(await rows(butlerName)).toHaveLength(1);
  });

  it("stays out of the way during maintenance", async () => {
    const chain = new FakeChain();
    chain.balances.USDC = 5_000_000n;
    setWalletChainOverride({ chain, owner: OWNER });
    const butlerName = "earner-busy";
    await butler(butlerName).acquireMaintenance("export", "op-earner");
    try {
      expect(await butler(butlerName).ensureEarner()).toBe("busy");
      expect(await rows(butlerName)).toEqual([]);
    } finally {
      await butler(butlerName).releaseMaintenance("op-earner");
    }
  });
});
