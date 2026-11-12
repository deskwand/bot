import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createAdminGateway,
  type AdminDeps,
} from "../../src/admin/admin-gateway";
import { BotsRepo } from "../../src/butler/bots-repo";
import type { Vitals } from "../../src/life/vitals";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "test-admin-token";
const OP = "op-test";

function deps(name: string, token: string | null = TOKEN): AdminDeps {
  return {
    token: token ?? undefined,
    versionId: "version-test",
    butler: () => env.BUTLER.get(env.BUTLER.idFromName(name)),
    channel: () =>
      env.CHANNELS.get(env.CHANNELS.idFromName(`${name}-channels`)),
    task: (id) => env.TASK.get(env.TASK.idFromName(id)),
    bot: (id) => env.BOT.get(env.BOT.idFromName(id)),
    life: () => env.LIFE.get(env.LIFE.idFromName(`${name}-life`)),
    wallet: () => env.WALLET.get(env.WALLET.idFromName("global")),
    artifacts: env.ARTIFACTS,
    mcpAuth: () => env.MCP_AUTH.get(env.MCP_AUTH.idFromName("global")),
  };
}

function call(
  gateway: ReturnType<typeof createAdminGateway>,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    token?: string | null;
    opId?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers({ "x-backup-op": init.opId ?? OP });
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return gateway.fetch(
    new Request(`https://example.com${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

async function acquire(
  gateway: ReturnType<typeof createAdminGateway>,
  opId = OP,
): Promise<Response> {
  return call(gateway, "/admin/maintenance/acquire", {
    method: "POST",
    body: { op: "export", opId },
  });
}

async function expireLease(name: string): Promise<void> {
  for (const [namespace, id] of [
    [env.BUTLER, name],
    [env.CHANNELS, `${name}-channels`],
  ] as const) {
    await runInDurableObject(
      namespace.get(namespace.idFromName(id)),
      (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE admin_maintenance SET until = ?`,
          Date.now() - 1,
        );
      },
    );
  }
}

describe("admin gateway", () => {
  it("returns 404 for every admin path when ADMIN_TOKEN is unset", async () => {
    const gateway = createAdminGateway(deps("admin-unset", null));

    const requests = [
      ["POST", "/admin/maintenance/acquire", { op: "export", opId: OP }],
      ["POST", "/admin/maintenance/release", undefined],
      ["GET", "/admin/backup/info", undefined],
      ["GET", "/admin/backup/schema?do=butler", undefined],
      ["POST", "/admin/backup/page?do=butler", { table: {}, cursor: null }],
      ["POST", "/admin/restore/begin?do=butler", { schema: {} }],
      ["POST", "/admin/restore/page?do=butler", { table: {}, rows: [] }],
      ["POST", "/admin/restore/commit?do=butler", { schema: {} }],
      ["POST", "/admin/restore/reset?do=butler", undefined],
      ["GET", "/admin/unknown", undefined],
    ] as const;

    for (const [method, path, body] of requests) {
      const response = await call(gateway, path, { method, body });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("returns 401 for a wrong bearer token", async () => {
    const gateway = createAdminGateway(deps("admin-wrong-token"));

    const response = await call(gateway, "/admin/backup/info", {
      token: "wrong",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "ADMIN_UNAUTHORIZED" });
  });

  it("returns 401 for an exchange snapshot without a bearer token", async () => {
    const gateway = createAdminGateway(deps("admin-snapshot-no-token"));

    const response = await call(gateway, "/admin/exchange/snapshot", {
      method: "POST",
      body: { account: "bn-main", fetchedAt: 1, responses: [] },
      token: null,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "ADMIN_UNAUTHORIZED" });
  });

  it("returns 409 MAINTENANCE_REQUIRED without a lease", async () => {
    const gateway = createAdminGateway(deps("admin-no-lease"));

    const response = await call(gateway, "/admin/backup/info");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "MAINTENANCE_REQUIRED" });
  });

  it("returns 409 MAINTENANCE_BUSY for a second opId", async () => {
    const gateway = createAdminGateway(deps("admin-busy"));

    const first = await acquire(gateway, "op-a");
    expect(first.status).toBe(200);
    expect(typeof ((await first.json()) as { until: unknown }).until).toBe(
      "number",
    );

    const second = await acquire(gateway, "op-b");
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ code: "MAINTENANCE_BUSY" });
  });

  it("info lists bot ids", async () => {
    const name = "admin-bot-ids";
    const gateway = createAdminGateway(deps(name));
    await runInDurableObject(
      env.BUTLER.get(env.BUTLER.idFromName(name)),
      (_instance, state) => {
        new BotsRepo(state.storage.sql).insert({
          id: "b1",
          name: "价格哨兵",
        });
      },
    );
    expect((await acquire(gateway)).status).toBe(200);

    const response = await call(gateway, "/admin/backup/info");

    expect(response.status).toBe(200);
    const info = (await response.json()) as { botIds: string[] };
    expect(info.botIds).toEqual(["b1"]);
  });

  it("schema accepts do=bot", async () => {
    const gateway = createAdminGateway(deps("admin-bot-schema"));
    expect((await acquire(gateway)).status).toBe(200);

    const response = await call(gateway, "/admin/backup/schema?do=bot&id=b1");

    expect(response.status).toBe(200);
    const schema = (await response.json()) as {
      tables: { name: string }[];
    };
    expect(schema.tables.map((table) => table.name)).toContain("runs");
  });

  it("schema accepts do=life", async () => {
    const gateway = createAdminGateway(deps("admin-life-schema"));
    expect((await acquire(gateway)).status).toBe(200);

    const response = await call(gateway, "/admin/backup/schema?do=life");

    expect(response.status).toBe(200);
    const schema = (await response.json()) as {
      tables: { name: string }[];
    };
    const names = schema.tables.map((table) => table.name);
    expect(names).toContain("spend");
    expect(names).toContain("credit");
  });

  it("schema accepts do=wallet", async () => {
    const gateway = createAdminGateway(deps("admin-wallet-schema"));
    expect((await acquire(gateway)).status).toBe(200);

    const response = await call(gateway, "/admin/backup/schema?do=wallet");

    expect(response.status).toBe(200);
    const schema = (await response.json()) as {
      tables: { name: string }[];
    };
    const names = schema.tables.map((table) => table.name);
    expect(names).toContain("remittances");
  });

  it("returns 400 for an unknown do kind", async () => {
    const gateway = createAdminGateway(deps("admin-unknown-do"));
    expect((await acquire(gateway)).status).toBe(200);

    const response = await call(gateway, "/admin/backup/schema?do=database");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "BACKUP_INVALID" });
  });

  it("returns 500 BACKUP_INVALID when an RPC throws", async () => {
    const gateway = createAdminGateway(deps("admin-rpc-error"));
    expect((await acquire(gateway)).status).toBe(200);

    const response = await call(gateway, "/admin/restore/page?do=butler", {
      method: "POST",
      body: {
        table: { name: "does_not_exist", create: "", withoutRowid: false },
        rows: [{ __rowid: 1, x: "y" }],
      },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "BACKUP_INVALID",
      message: "backup request failed",
    });
  });

  it("releases the Butler lease when the Channel acquire throws", async () => {
    const released: string[] = [];
    const gateway = createAdminGateway({
      token: TOKEN,
      versionId: "version-test",
      butler: () =>
        ({
          acquireMaintenance: async () => ({
            until: 1,
            op: "export",
            opId: OP,
          }),
          releaseMaintenance: async (opId: string) => {
            released.push(opId);
          },
        }) as unknown as ReturnType<AdminDeps["butler"]>,
      channel: () =>
        ({
          acquireMaintenance: async () => {
            throw new Error("channel down");
          },
        }) as unknown as ReturnType<AdminDeps["channel"]>,
      task: () => {
        throw new Error("unused");
      },
      bot: () => {
        throw new Error("unused");
      },
      life: () => {
        throw new Error("unused");
      },
      wallet: () => {
        throw new Error("unused");
      },
      artifacts: env.ARTIFACTS,
      mcpAuth: () => env.MCP_AUTH.get(env.MCP_AUTH.idFromName("global")),
    });

    const response = await acquire(gateway);

    expect(response.status).toBe(500);
    expect(released).toEqual([OP]);
  });

  it("releases without a live lease", async () => {
    const name = "admin-release-expired";
    const gateway = createAdminGateway(deps(name));
    expect((await acquire(gateway, "op-a")).status).toBe(200);
    await expireLease(name);

    const released = await call(gateway, "/admin/maintenance/release", {
      method: "POST",
    });

    expect(released.status).toBe(204);
    expect((await acquire(gateway, "op-b")).status).toBe(200);
  });

  it("does not release another operation's lease", async () => {
    const gateway = createAdminGateway(deps("admin-release-other"));
    expect((await acquire(gateway)).status).toBe(200);

    const other = await call(gateway, "/admin/maintenance/release", {
      method: "POST",
      opId: "op-b",
    });
    expect(other.status).toBe(204);

    expect((await call(gateway, "/admin/backup/info")).status).toBe(200);
  });

  it("serves life vitals without a maintenance lease", async () => {
    const gateway = createAdminGateway(deps("admin-life-vitals"));

    const response = await call(gateway, "/admin/life/vitals");

    expect(response.status).toBe(200);
    const body = (await response.json()) as Vitals;
    expect(body.tier).toBe("ample");
    expect(body.metabolismStarted).toBe(false);
  });

  it("refuses life vitals without the admin token", async () => {
    const gateway = createAdminGateway(deps("admin-life-noauth"));

    const response = await call(gateway, "/admin/life/vitals", {
      token: null,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "ADMIN_UNAUTHORIZED" });
  });
});
