import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAdminGateway,
  type AdminDeps,
} from "../../src/admin/admin-gateway";
import { BackupRpc } from "../../src/admin/backup-rpc";
import type {
  DbSchema,
  DumpPage,
  DumpRow,
  TableSchema,
} from "../../src/admin/sql-dump";
import type { ButlerDO } from "../../src/butler/butler-do";
import {
  MemoryStore,
  renderMemorySection,
} from "../../src/butler/memory";
import type { ScheduleRow, ScheduleStore } from "../../src/butler/schedules";
import { setChannelOverride } from "../../src/channels/override";
import type { BotMeta } from "../../src/bot/bot-store";
import { MIN_WAKE_MS } from "../../src/bot/wake";
import { setClockOverride } from "../../src/butler/notifier";
import type { SpendEntry } from "../../src/life/books";
import type { Tier } from "../../src/life/vitals";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { fakeChannel } from "../helpers/fake-channel";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "test-admin-token";
const OP = "op-e2e";

const DAY_MS = 86_400_000;
const START = Date.UTC(2030, 0, 1, 9, 0, 0);

function spend(usd: number, at: number): SpendEntry {
  return {
    callId: crypto.randomUUID(),
    at,
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

type DumpedTable = { table: TableSchema; rows: DumpRow[] };

type DumpedDo = { schema: DbSchema; tables: DumpedTable[] };

type ButlerPrivate = {
  memory: MemoryStore;
  schedules: ScheduleStore;
  marker?: string;
};

function deps(): AdminDeps {
  return {
    token: TOKEN,
    versionId: env.CF_VERSION_METADATA.id,
    butler: () => env.BUTLER.get(env.BUTLER.idFromName("owner")),
    channel: () => env.CHANNELS.get(env.CHANNELS.idFromName("channels")),
    task: (id) => env.TASK.get(env.TASK.idFromName(id)),
    bot: (id) => env.BOT.get(env.BOT.idFromName(id)),
    life: () => env.LIFE.get(env.LIFE.idFromName("global")),
    artifacts: env.ARTIFACTS,
    mcpAuth: () => env.MCP_AUTH.get(env.MCP_AUTH.idFromName("global")),
  };
}

const gateway = createAdminGateway(deps());

function call(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const headers = new Headers({
    authorization: `Bearer ${TOKEN}`,
    "x-backup-op": OP,
  });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return gateway.fetch(
    new Request(`https://example.com${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

function target(ref: { do: string; id: string }): string {
  return `do=${ref.do}&id=${encodeURIComponent(ref.id)}`;
}

async function acquire(op: "export" | "restore"): Promise<void> {
  const response = await call("/admin/maintenance/acquire", {
    method: "POST",
    body: { op, opId: OP },
  });
  expect(response.status).toBe(200);
}

async function release(): Promise<void> {
  const response = await call("/admin/maintenance/release", {
    method: "POST",
  });
  expect(response.status).toBe(204);
}

async function dumpDo(ref: { do: string; id: string }): Promise<DumpedDo> {
  const query = target(ref);
  const schemaResponse = await call(`/admin/backup/schema?${query}`);
  expect(schemaResponse.status).toBe(200);
  const schema = (await schemaResponse.json()) as DbSchema;

  const tables: DumpedTable[] = [];
  for (const table of schema.tables) {
    const rows: DumpRow[] = [];
    let cursor: string | null = null;
    do {
      const response = await call(`/admin/backup/page?${query}`, {
        method: "POST",
        body: { table, cursor },
      });
      expect(response.status).toBe(200);
      const page = (await response.json()) as DumpPage;
      rows.push(...page.rows);
      cursor = page.next;
    } while (cursor !== null);
    tables.push({ table, rows });
  }
  return { schema, tables };
}

async function resetDo(ref: { do: string; id: string }): Promise<void> {
  const response = await call(`/admin/restore/reset?${target(ref)}`, {
    method: "POST",
  });
  expect(response.status).toBe(204);
}

async function restoreDo(
  ref: { do: string; id: string },
  dumped: DumpedDo,
): Promise<void> {
  const query = target(ref);
  await resetDo(ref);

  let response = await call(`/admin/restore/begin?${query}`, {
    method: "POST",
    body: { schema: dumped.schema },
  });
  expect(response.status).toBe(204);

  for (const { table, rows } of dumped.tables) {
    if (rows.length === 0) continue;
    response = await call(`/admin/restore/page?${query}`, {
      method: "POST",
      body: { table, rows },
    });
    expect(response.status).toBe(204);
  }

  response = await call(`/admin/restore/commit?${query}`, {
    method: "POST",
    body: { schema: dumped.schema },
  });
  expect(response.status).toBe(204);

  await resetDo(ref);
}

beforeEach(async () => {
  setChannelOverride("telegram", fakeChannel().adapter);
  await seedOwnerAddress("42");
});

afterEach(() => {
  setChannelOverride("telegram", null);
});

describe("restore reset", () => {
  it("aborts the object so the next request reconstructs it", () => {
    const calls: unknown[][] = [];
    const ctx = {
      abort: (...args: unknown[]) => {
        calls.push(args);
      },
    } as unknown as DurableObjectState;

    new BackupRpc(ctx, null).restoreReset();

    expect(calls).toEqual([["data restored"]]);
  });
});

describe("backup and restore end to end", () => {
  it("restores memories, schedules, tasks and KV into a fresh deployment", async () => {
    const butler = env.BUTLER.get(env.BUTLER.idFromName("owner"));

    // Write through the public RPCs where they exist; the private stores are
    // reached the same way the rest of the suite does.
    await butler.createSchedule("0 3 1 1 *", "年度提醒", "提醒主人备份");
    const taskId = await butler.spawn("备份任务", "什么也不做");

    const before = await runInDurableObject(
      butler,
      async (instance, state) => {
        const typed = instance as unknown as ButlerPrivate;
        typed.memory.add("喜欢绿茶");
        await state.storage.put("probe-kv", { n: 1 });
        return {
          schedules: typed.schedules.list(),
          taskIds: instance.listTaskIds(),
          memories: typed.memory.all().map((item) => item.content),
        };
      },
    );

    // Export: info, then every table of every object, then the lease releases.
    await acquire("export");
    const infoResponse = await call("/admin/backup/info");
    expect(infoResponse.status).toBe(200);
    const info = (await infoResponse.json()) as {
      versionId: string;
      taskIds: string[];
    };
    expect(info.versionId).toBe(env.CF_VERSION_METADATA.id);
    expect(info.taskIds).toEqual([taskId]);

    const butlerDump = await dumpDo({ do: "butler", id: "" });
    const taskDump = await dumpDo({ do: "task", id: taskId });
    const channelDump = await dumpDo({ do: "channel", id: "" });

    // Sanity: each object really was dumped, including the KV pseudo-table.
    expect(butlerDump.tables.some(({ table }) => table.name === "memories")).toBe(
      true,
    );
    expect(butlerDump.tables.some(({ table }) => table.name === "__kv")).toBe(
      true,
    );
    expect(taskDump.tables.some(({ table }) => table.name === "meta")).toBe(
      true,
    );
    expect(
      channelDump.tables.some(({ table }) => table.name === "owner_addresses"),
    ).toBe(true);

    await release();

    // A memory written after the backup must not survive the restore.
    await runInDurableObject(butler, (instance) => {
      const typed = instance as unknown as ButlerPrivate;
      typed.memory.add("多余");
      typed.marker = "stale";
    });

    // Restore order: tasks, channel, then the Butler last.
    await acquire("restore");
    await restoreDo({ do: "task", id: taskId }, taskDump);
    await restoreDo({ do: "channel", id: "" }, channelDump);
    await restoreDo({ do: "butler", id: "" }, butlerDump);
    await release();

    // The next request must construct a new Butler instance and read memory
    // from storage, not from the pre-restore process memory. The Vitest pool
    // caches an instance per stub, so re-fetch the stub like a real request
    // would; the instance behind the old stub was reset by `restoreReset`.
    const butlerAfterReset = env.BUTLER.get(env.BUTLER.idFromName("owner"));
    const after = await runInDurableObject(
      butlerAfterReset,
      async (instance, state) => {
        const typed = instance as unknown as ButlerPrivate;
        return {
          rendered: renderMemorySection(typed.memory.all()),
          memories: typed.memory.all().map((item) => item.content),
          schedules: typed.schedules.list() as ScheduleRow[],
          taskIds: instance.listTaskIds(),
          kv: (await state.storage.get("probe-kv")) as unknown,
          marker: typed.marker ?? null,
        };
      },
    );

    expect(after.memories).toEqual(before.memories);
    expect(after.rendered).toContain("喜欢绿茶");
    expect(after.rendered).not.toContain("多余");
    expect(after.schedules).toEqual(before.schedules);
    expect(after.taskIds).toEqual(before.taskIds);
    expect(after.kv).toEqual({ n: 1 });
    expect(after.marker).toBeNull();

    // The Task and Channel objects were restored through the same chain.
    const taskMeta = await runInDurableObject(
      env.TASK.get(env.TASK.idFromName(taskId)),
      (_instance, state) =>
        state.storage.sql
          .exec<{ value: string }>(
            `SELECT value FROM meta WHERE key = 'task_id'`,
          )
          .toArray(),
    );
    expect(taskMeta).toEqual([{ value: taskId }]);

    const addresses = await runInDurableObject(
      env.CHANNELS.get(env.CHANNELS.idFromName("channels")),
      (_instance, state) =>
        state.storage.sql
          .exec<{ channel: string; conversation_id: string }>(
            `SELECT channel, conversation_id FROM owner_addresses`,
          )
          .toArray(),
    );
    expect(addresses).toEqual([{ channel: "telegram", conversation_id: "42" }]);
  });

  it("migrates a legacy bot backup into the memory document", async () => {
    const now = Date.UTC(2030, 0, 1, 9, 0, 0);
    const meta: BotMeta = {
      botId: "legacy-b1",
      name: "价格哨兵",
      mission: "盯着价格",
      status: "active",
      nextWakeAt: null,
      defaultIntervalMs: 86_400_000,
      currentTaskId: null,
      consecutiveFailures: 0,
      wakesDay: null,
      wakesCount: 0,
      pendingSteer: [],
    };
    const metaTable: TableSchema = {
      name: "meta",
      create: `CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      withoutRowid: false,
    };
    const runsTable: TableSchema = {
      name: "runs",
      create: `CREATE TABLE runs (
        task_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT,
        summary TEXT,
        note TEXT
      )`,
      withoutRowid: false,
    };
    const memoriesTable: TableSchema = {
      name: "memories",
      create: `CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      withoutRowid: false,
    };
    const legacyDump: DumpedDo = {
      schema: {
        tables: [metaTable, runsTable, memoriesTable],
        indexes: [],
      },
      tables: [
        {
          table: metaTable,
          rows: [{ __rowid: 1, key: "bot", value: JSON.stringify(meta) }],
        },
        { table: runsTable, rows: [] },
        {
          table: memoriesTable,
          rows: [{ __rowid: 1, id: 1, content: "喜欢绿茶", created_at: now }],
        },
      ],
    };

    await acquire("restore");
    await restoreDo({ do: "bot", id: "legacy-b1" }, legacyDump);
    await release();

    // The restore reset the old instance; the fresh one migrates on construct.
    const bot = env.BOT.get(env.BOT.idFromName("legacy-b1"));
    const snapshot = await bot.snapshot();
    expect(snapshot?.docs).toEqual([
      { name: "记忆", content: "- 喜欢绿茶" },
    ]);
  });

  it("bot memory and alarm survive a restore", async () => {
    const now = Date.UTC(2030, 0, 1, 9, 0, 0);
    setClockOverride({
      now: () => now,
      setTimeout: () => 0,
      clearTimeout: () => {},
    });

    try {
      const bot = env.BOT.get(env.BOT.idFromName("b1"));
      await bot.init({
        botId: "b1",
        name: "价格哨兵",
        mission: "盯着价格",
        defaultIntervalMs: 86_400_000,
        // Already due: the restore must not wake the bot immediately.
        firstWakeAt: now - 60_000,
      });
      await bot.writeDoc("记忆", "- 喜欢绿茶", { allowRules: false });

      await acquire("export");
      const botDump = await dumpDo({ do: "bot", id: "b1" });
      await release();

      await acquire("restore");
      await restoreDo({ do: "bot", id: "b1" }, botDump);
      await release();

      // `restoreReset` aborted the old instance; fetch a fresh stub the way a
      // real request would.
      const botAfter = env.BOT.get(env.BOT.idFromName("b1"));
      const snapshot = await botAfter.snapshot();
      expect(snapshot?.docs).toEqual([
        { name: "记忆", content: "- 喜欢绿茶" },
      ]);

      const alarm = await runInDurableObject(
        botAfter,
        (_instance, state) => state.storage.getAlarm(),
      );
      expect(alarm).toBe(now + MIN_WAKE_MS);
    } finally {
      setClockOverride(null);
    }
  });
});

describe("life ledger backup and restore", () => {
  it("restores the books and the last notified tier", async () => {
    let now = START;
    setClockOverride({
      now: () => now,
      setTimeout: () => 0,
      clearTimeout: () => {},
    });

    try {
      const life = env.LIFE.get(env.LIFE.idFromName("global"));
      await life.recordCredit(20, "");
      for (let day = 0; day < 6; day += 1) {
        now = START + Math.round((day + 0.5) * DAY_MS);
        await life.recordSpend(spend(2, now));
      }
      now = START + 6 * DAY_MS;

      const before = await life.vitals();
      expect(before).toMatchObject({
        balanceUsd: 8,
        tier: "lean",
        metabolismStarted: true,
      });

      await acquire("export");
      const lifeDump = await dumpDo({ do: "life", id: "" });
      await release();

      // The ledger and the KV table that holds notified_tier are both in it.
      expect(
        lifeDump.tables.find(({ table }) => table.name === "spend")?.rows,
      ).toHaveLength(6);
      expect(
        lifeDump.tables.find(({ table }) => table.name === "credit")?.rows,
      ).toHaveLength(1);
      expect(
        lifeDump.tables.find(({ table }) => table.name === "__kv")?.rows,
      ).not.toHaveLength(0);

      await acquire("restore");
      await restoreDo({ do: "life", id: "" }, lifeDump);
      await release();

      const restored = env.LIFE.get(env.LIFE.idFromName("global"));
      const after = await restored.vitals();
      expect(after).toMatchObject({
        balanceUsd: before.balanceUsd,
        tier: before.tier,
        metabolismStarted: before.metabolismStarted,
      });

      const notices: Tier[] = [];
      await runInDurableObject(restored, (instance) => {
        instance.notifyTierChange = async (tier) => {
          notices.push(tier);
        };
      });

      // The next spend must not announce lean a second time.
      now = START + 6 * DAY_MS + 60_000;
      await restored.recordSpend(spend(0.5, now));

      expect((await restored.vitals()).tier).toBe("lean");
      expect(notices).toEqual([]);
    } finally {
      setClockOverride(null);
    }
  });

  it("restores an old backup with no ledger as ample and not started", async () => {
    const now = START;
    setClockOverride({
      now: () => now,
      setTimeout: () => 0,
      clearTimeout: () => {},
    });

    try {
      const life = env.LIFE.get(env.LIFE.idFromName("global"));
      await life.recordCredit(20, "");
      await life.recordSpend(spend(3, now));
      expect((await life.vitals()).metabolismStarted).toBe(true);

      // An old backup has no life object at all; restoring its (empty) shape
      // is what leaves the ledger with no tables.
      const legacy = { schema: { tables: [], indexes: [] }, tables: [] };
      await acquire("restore");
      await restoreDo({ do: "life", id: "" }, legacy);
      await release();

      const restored = env.LIFE.get(env.LIFE.idFromName("global"));
      expect(await restored.vitals()).toEqual({
        balanceUsd: 0,
        dailySpendUsd: 0,
        runwayDays: null,
        tier: "ample",
        metabolismStarted: false,
        unpriced: false,
        topSources: [],
      });
    } finally {
      setClockOverride(null);
    }
  });
});
