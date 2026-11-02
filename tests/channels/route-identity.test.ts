import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelDO } from "../../src/channels/channel-do";
import { setWeChatCredentialsOverride } from "../../src/channels/override";
import type { RouteSnapshot } from "../../src/protocol";
import {
  DISABLED_ROUTE_KEY,
  parseActiveChannel,
  routeIdentity,
  versionIdOf,
} from "../../src/channels/route-identity";

describe("parseActiveChannel", () => {
  it("defaults to telegram when the variable is absent", () => {
    expect(parseActiveChannel(undefined)).toBe("telegram");
  });

  it("accepts both configured channels", () => {
    expect(parseActiveChannel("telegram")).toBe("telegram");
    expect(parseActiveChannel("wechat")).toBe("wechat");
  });

  it("treats empty and unknown values as disabled, not as telegram", () => {
    expect(parseActiveChannel("")).toBeNull();
    expect(parseActiveChannel("other")).toBeNull();
    expect(parseActiveChannel("Telegram")).toBeNull();
    expect(parseActiveChannel(" telegram")).toBeNull();
  });
});

describe("versionIdOf", () => {
  it("rejects a deployment without the version binding", () => {
    expect(versionIdOf(undefined)).toBeNull();
  });

  it("uses dev when the local binding carries no id", () => {
    expect(versionIdOf({})).toBe("dev");
    expect(versionIdOf({ id: "" })).toBe("dev");
  });

  it("uses the deployed version id when present", () => {
    expect(versionIdOf({ id: "v1" })).toBe("v1");
  });
});

describe("routeIdentity", () => {
  it("is deterministic for the same deployment and target", async () => {
    const first = await routeIdentity({
      versionId: "v1",
      channel: "telegram",
      targetIdentityHash: "tg1",
    });
    const repeated = await routeIdentity({
      versionId: "v1",
      channel: "telegram",
      targetIdentityHash: "tg1",
    });

    expect(first.channel).toBe("telegram");
    expect(repeated.routeKey).toBe(first.routeKey);
    expect(first.routeKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the deployment changes, even for the same target", async () => {
    const first = await routeIdentity({
      versionId: "v1",
      channel: "telegram",
      targetIdentityHash: "tg1",
    });
    const redeployed = await routeIdentity({
      versionId: "v3",
      channel: "telegram",
      targetIdentityHash: "tg1",
    });

    expect(redeployed.routeKey).not.toBe(first.routeKey);
  });

  it("does not reuse a key after switching away and back without observing the middle deployment", async () => {
    const tgA = await routeIdentity({
      versionId: "deploy-a",
      channel: "telegram",
      targetIdentityHash: "tg1",
    });
    // The intermediate wechat deployment never wakes the Channel DO.
    void (await routeIdentity({
      versionId: "deploy-b",
      channel: "wechat",
      targetIdentityHash: "wx1",
    }));
    const tgBack = await routeIdentity({
      versionId: "deploy-c",
      channel: "telegram",
      targetIdentityHash: "tg1",
    });

    expect(tgBack.routeKey).not.toBe(tgA.routeKey);
  });

  it("changes when the target identity changes", async () => {
    const first = await routeIdentity({
      versionId: "v1",
      channel: "wechat",
      targetIdentityHash: "wx1",
    });
    const rotated = await routeIdentity({
      versionId: "v1",
      channel: "wechat",
      targetIdentityHash: "wx2",
    });

    expect(rotated.routeKey).not.toBe(first.routeKey);
  });

  it("never contains the raw target material", async () => {
    const route = await routeIdentity({
      versionId: "v1",
      channel: "telegram",
      targetIdentityHash: "123456:super-secret-token",
    });

    expect(route.routeKey).not.toContain("super-secret-token");
    expect(route.routeKey).not.toContain("123456");
  });

  it("disables the route for an invalid selection without pretending it is telegram", async () => {
    const route = await routeIdentity({
      versionId: "v1",
      channel: null,
      targetIdentityHash: "tg1",
    });

    expect(route).toEqual({ channel: null, routeKey: DISABLED_ROUTE_KEY });
  });
});

describe("ChannelDO.currentRoute", () => {
  const restore: Array<() => void> = [];

  function setEnv(patch: Record<string, unknown>): void {
    const target = env as unknown as Record<string, unknown>;
    const previous = new Map<string, unknown>();
    for (const [key, value] of Object.entries(patch)) {
      previous.set(key, target[key]);
      target[key] = value;
    }
    restore.push(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete target[key];
        else target[key] = value;
      }
    });
  }

  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  function freshHub(name: string) {
    return env.CHANNELS.get(env.CHANNELS.idFromName(name));
  }

  it("reads the active channel from the environment and caches this instance's route", async () => {
    const hub = freshHub("route-telegram");

    const first = await hub.currentRoute();
    const again = await hub.currentRoute();

    expect(first.channel).toBe("telegram");
    expect(again).toEqual(first);
    expect(first.routeKey).not.toBe("disabled");
  });

  it("does not touch butler tasks, memory or schedules", async () => {
    const butler = env.BUTLER.get(env.BUTLER.idFromName("route-untouched"));
    const snapshot = () =>
      runInDurableObject(butler, (_instance, state) => {
        const tables = state.storage.sql
          .exec<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
          )
          .toArray()
          .map((row) => row.name);
        return {
          tables,
          tasks: state.storage.sql
            .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM tasks`)
            .toArray()[0]?.count,
          meta: state.storage.sql
            .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM meta`)
            .toArray()[0]?.count,
        };
      });

    const before = await snapshot();
    const hub = freshHub("route-untouched");
    await hub.currentRoute();
    const schedules = await runInDurableObject(hub, (instance) =>
      instance.listSchedules(),
    );

    expect(await snapshot()).toEqual(before);
    expect(schedules).toEqual([]);
  });

  it("disables the route for an invalid ACTIVE_CHANNEL without falling back", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ ACTIVE_CHANNEL: "slack" });

    const route = await freshHub("route-invalid").currentRoute();

    expect(route.channel).toBeNull();
    expect(route.routeKey).toBe("disabled");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("disables the route when the version binding is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ CF_VERSION_METADATA: undefined });

    const route = await freshHub("route-no-version").currentRoute();

    expect(route.channel).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("treats a selected channel without credentials as selected but unusable", async () => {
    setEnv({ ACTIVE_CHANNEL: "wechat", WECHAT_CREDENTIALS: undefined });

    const route = await freshHub("route-wechat-unconfigured").currentRoute();

    expect(route.channel).toBe("wechat");
    expect(route.routeKey).not.toBe("disabled");
  });
});

describe("resolveRoute wiring (independent env snapshots)", () => {
  const WX_A = JSON.stringify({
    token: "token-a",
    baseUrl: "https://ilinkai.weixin.qq.com",
    accountId: "account-a",
    userId: "wx-owner",
  });
  const WX_B = JSON.stringify({
    token: "token-b",
    baseUrl: "https://ilinkai.weixin.qq.com",
    accountId: "account-b",
    userId: "wx-owner",
  });

  afterEach(() => {
    setWeChatCredentialsOverride(null);
  });

  /** Builds a ChannelDO over a DO's real state with a snapshot env fixture. */
  async function routeWith(
    name: string,
    values: Record<string, unknown>,
  ): Promise<RouteSnapshot> {
    const hub = env.CHANNELS.get(env.CHANNELS.idFromName(name));
    return runInDurableObject(hub, (_instance, state) => {
      const snapshot = { ...(env as unknown as Env), ...values } as Env;
      const fixture = new ChannelDO(state, snapshot);
      return fixture.currentRoute();
    });
  }

  it("derives the WeChat identity from the environment, not the test override", async () => {
    setWeChatCredentialsOverride(WX_A);
    const withoutEnvCredentials = await routeWith("wiring-override-a", {
      ACTIVE_CHANNEL: "wechat",
      WECHAT_CREDENTIALS: undefined,
    });

    setWeChatCredentialsOverride(WX_B);
    const stillWithoutEnvCredentials = await routeWith("wiring-override-b", {
      ACTIVE_CHANNEL: "wechat",
      WECHAT_CREDENTIALS: undefined,
    });

    expect(stillWithoutEnvCredentials.routeKey).toBe(
      withoutEnvCredentials.routeKey,
    );

    const withEnvCredentials = await routeWith("wiring-env-creds", {
      ACTIVE_CHANNEL: "wechat",
      WECHAT_CREDENTIALS: WX_A,
    });
    expect(withEnvCredentials.routeKey).not.toBe(
      withoutEnvCredentials.routeKey,
    );
  });

  it("changes the key with the deployment, Telegram token and WeChat credentials", async () => {
    const base = { ACTIVE_CHANNEL: "telegram", TELEGRAM_BOT_TOKEN: "t1" };
    const first = await routeWith("wiring-tg-v1", {
      ...base,
      CF_VERSION_METADATA: { id: "v1" },
    });
    const redeployed = await routeWith("wiring-tg-v2", {
      ...base,
      CF_VERSION_METADATA: { id: "v2" },
    });
    const rotatedToken = await routeWith("wiring-tg-token", {
      ...base,
      TELEGRAM_BOT_TOKEN: "t2",
      CF_VERSION_METADATA: { id: "v1" },
    });

    expect(redeployed.routeKey).not.toBe(first.routeKey);
    expect(rotatedToken.routeKey).not.toBe(first.routeKey);

    const wxOne = await routeWith("wiring-wx-a", {
      ACTIVE_CHANNEL: "wechat",
      WECHAT_CREDENTIALS: WX_A,
      CF_VERSION_METADATA: { id: "v1" },
    });
    const wxTwo = await routeWith("wiring-wx-b", {
      ACTIVE_CHANNEL: "wechat",
      WECHAT_CREDENTIALS: WX_B,
      CF_VERSION_METADATA: { id: "v1" },
    });
    expect(wxTwo.routeKey).not.toBe(wxOne.routeKey);
  });

  it("ignores owner order and duplicates in the Telegram identity", async () => {
    const model = { provider: "opencode-go", id: "deepseek-v4.1-flash" };
    const config = (telegramUserIds: number[]) => ({
      schemaVersion: 1,
      owner: { telegramUserIds },
      models: { butler: model, task: model },
      mcpServers: [],
    });
    const base = {
      ACTIVE_CHANNEL: "telegram",
      TELEGRAM_BOT_TOKEN: "t1",
      CF_VERSION_METADATA: { id: "v1" },
    };

    const first = await routeWith("wiring-owner-order-a", {
      ...base,
      DESKWAND_CONFIG: config([2, 1, 1]),
    });
    const reordered = await routeWith("wiring-owner-order-b", {
      ...base,
      DESKWAND_CONFIG: config([1, 2]),
    });
    const changed = await routeWith("wiring-owner-order-c", {
      ...base,
      DESKWAND_CONFIG: config([1, 3]),
    });

    expect(reordered.routeKey).toBe(first.routeKey);
    expect(changed.routeKey).not.toBe(first.routeKey);
  });

  it("keeps an existing instance on its own snapshot when a newer fixture exists", async () => {
    const hub = env.CHANNELS.get(env.CHANNELS.idFromName("wiring-stable"));
    const result = await runInDurableObject(hub, async (_instance, state) => {
      const older = new ChannelDO(state, {
        ...(env as unknown as Env),
        ACTIVE_CHANNEL: "telegram",
        TELEGRAM_BOT_TOKEN: "t1",
        CF_VERSION_METADATA: { id: "v1" },
      } as Env);
      const before = await older.currentRoute();
      const newer = new ChannelDO(state, {
        ...(env as unknown as Env),
        ACTIVE_CHANNEL: "wechat",
        WECHAT_CREDENTIALS: WX_A,
        CF_VERSION_METADATA: { id: "v2" },
      } as Env);
      const newerRoute = await newer.currentRoute();
      const after = await older.currentRoute();
      return { before, newerRoute, after };
    });

    expect(result.after).toEqual(result.before);
    expect(result.newerRoute.routeKey).not.toBe(result.before.routeKey);
  });

  it("disables business routing for an invalid selection in the snapshot", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const route = await routeWith("wiring-invalid", {
      ACTIVE_CHANNEL: "slack",
      CF_VERSION_METADATA: { id: "v1" },
    });

    expect(route).toEqual({ channel: null, routeKey: "disabled" });
    error.mockRestore();
  });
});
