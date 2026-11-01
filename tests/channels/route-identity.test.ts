import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
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
