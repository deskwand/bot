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
    wallet: () => env.WALLET.get(env.WALLET.idFromName("global")),
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

// The desktop's clear path for an object that a backup does not contain:
// reset, begin with an empty schema, reset (clearDurableObject in
// desktop/internal/backup/restorer.go).
async function clearDo(ref: { do: string; id: string }): Promise<void> {
  await resetDo(ref);
  const response = await call(`/admin/restore/begin?${target(ref)}`, {
    method: "POST",
    body: { schema: { tables: [], indexes: [] } },
  });
  expect(response.status).toBe(204);
  await resetDo(ref);
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
    await butler.createSchedule(
      { cron: "0 3 1 1 *" },
      "年度提醒",
      "提醒主人备份",
    );
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
      // A subscription credential is deployment state, not owner data: it must
      // not travel in the archive.
      await life.saveModelCredential("openai-codex", {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: START + DAY_MS,
      });
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

      // Derived remote state: a quota cache must not travel in the archive
      // either, even when the instance happens to hold one.
      await runInDurableObject(life, async (_instance, state) => {
        await state.storage.kv.put("model_quota", {
          "openai-codex": { failure: { reason: "unreachable", at: 0 } },
        });
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
      expect(
        lifeDump.tables.find(({ table }) => table.name === "spend_hourly")?.rows,
      ).not.toHaveLength(0);
      const kvRows =
        lifeDump.tables.find(({ table }) => table.name === "__kv")?.rows ?? [];
      expect(
        kvRows.some((row) => String(row.key).startsWith("model_auth:")),
      ).toBe(false);
      expect(kvRows.some((row) => String(row.key) === "model_quota")).toBe(
        false,
      );

      await acquire("restore");
      await restoreDo({ do: "life", id: "" }, lifeDump);
      await release();

      const restored = env.LIFE.get(env.LIFE.idFromName("global"));
      expect(await restored.modelCredential("openai-codex")).toBeUndefined();
      const after = await restored.vitals();
      expect(after).toMatchObject({
        balanceUsd: before.balanceUsd,
        tier: before.tier,
        metabolismStarted: before.metabolismStarted,
      });

      const hourly = await runInDurableObject(
        restored,
        (_instance, state) =>
          state.storage.sql
            .exec<{ hour: number; source: string; usd: number }>(
              `SELECT hour, source, usd FROM spend_hourly ORDER BY hour, source`,
            )
            .toArray(),
      );
      expect(hourly.length).toBeGreaterThan(0);

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

      // An old backup has no life object at all; the desktop clears it with
      // reset -> begin(empty schema) -> reset.
      await acquire("restore");
      await clearDo({ do: "life", id: "" });
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

describe("wallet ledger backup and restore", () => {
  const USDC_HASH = `0x${"ab".repeat(32)}`;

  function wallet() {
    return env.WALLET.get(env.WALLET.idFromName("global"));
  }

  async function rows(): Promise<unknown[]> {
    return runInDurableObject(wallet(), (_instance, state) =>
      state.storage.sql
        .exec(
          `SELECT id, at, usdc, reason, tx_hash, nonce, raw, status, settled_at, error
           FROM remittances ORDER BY rowid`,
        )
        .toArray(),
    );
  }

  beforeEach(async () => {
    await runInDurableObject(wallet(), (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM remittances`);
    });
  });

  it("restores the remittances", async () => {
    await runInDurableObject(wallet(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO remittances
          (id, at, usdc, reason, tx_hash, status, settled_at, error)
         VALUES (?, ?, ?, ?, ?, 'confirmed', ?, NULL)`,
        "r1",
        START,
        "32000000",
        "auto",
        USDC_HASH,
        START + 60_000,
      );
      state.storage.sql.exec(
        `INSERT INTO remittances
          (id, at, usdc, reason, tx_hash, status, settled_at, error)
         VALUES (?, ?, ?, ?, NULL, 'failed', NULL, ?)`,
        "r2",
        START + 1_000,
        "6000000",
        "manual",
        "wallet.error.reverted",
      );
    });

    await acquire("export");
    const walletDump = await dumpDo({ do: "wallet", id: "" });
    await release();

    const dumped = walletDump.tables.find(
      ({ table }) => table.name === "remittances",
    );
    expect(dumped?.rows).toHaveLength(2);

    // A row written after the backup must not survive the restore.
    await runInDurableObject(wallet(), (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM remittances`);
      state.storage.sql.exec(
        `INSERT INTO remittances
          (id, at, usdc, reason, tx_hash, status, settled_at, error)
         VALUES ('stale', ?, '1', 'auto', NULL, 'pending', NULL, NULL)`,
        START,
      );
    });

    await acquire("restore");
    await restoreDo({ do: "wallet", id: "" }, walletDump);
    await release();

    expect(await rows()).toEqual([
      {
        id: "r1",
        at: START,
        usdc: "32000000",
        reason: "auto",
        tx_hash: USDC_HASH,
        nonce: null,
        raw: null,
        status: "confirmed",
        settled_at: START + 60_000,
        error: null,
      },
      {
        id: "r2",
        at: START + 1_000,
        usdc: "6000000",
        reason: "manual",
        tx_hash: null,
        nonce: null,
        raw: null,
        status: "failed",
        settled_at: null,
        error: "wallet.error.reverted",
      },
    ]);
  });

  it("clears the wallet when the backup has none", async () => {
    await runInDurableObject(wallet(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO remittances
          (id, at, usdc, reason, tx_hash, status, settled_at, error)
         VALUES ('r1', ?, '32000000', 'auto', NULL, 'confirmed', NULL, NULL)`,
        START,
      );
    });

    // An old backup has no wallet object at all; the desktop clears it with
    // reset -> begin(empty schema) -> reset.
    await acquire("restore");
    await clearDo({ do: "wallet", id: "" });
    await release();

    expect(await rows()).toEqual([]);
  });

  it("refuses a restore while a signed remittance is still in flight", async () => {
    await runInDurableObject(wallet(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO remittances
          (id, at, usdc, reason, tx_hash, nonce, raw, status, settled_at, error)
         VALUES ('r1', ?, '10000000', 'auto', ?, 0, ?, 'pending', NULL, NULL)`,
        START,
        USDC_HASH,
        "0xf8deadbeef",
      );
    });

    const outcome = await runInDurableObject(wallet(), async (instance) => {
      const messages: string[] = [];
      for (const attempt of [
        () => instance.restoreBegin({ tables: [], indexes: [] }),
        () => instance.restoreReset(),
      ]) {
        try {
          await attempt();
          messages.push("ok");
        } catch (error) {
          messages.push((error as Error).message);
        }
      }
      return messages;
    });

    expect(outcome).toEqual([
      "a remittance is still in flight; retry the restore in a few minutes",
      "a remittance is still in flight; retry the restore in a few minutes",
    ]);
    expect(await rows()).toHaveLength(1);
  });
});

import { SelfWakeStore } from "../../src/butler/self-wake";
import { renderSelfSection } from "../../src/butler/self-prompt";
import { setModelOverride } from "../../src/llm/models";
import { scriptedModel } from "../helpers/scripted-model";

describe("growth backup lifecycle", () => {
  afterEach(() => setModelOverride(null));
  it("round-trips revisions, evidence, intent and retry quota, then restores old backups as empty growth", async () => {
    const target = { do: "butler", id: "" };
    let stub = env.BUTLER.get(env.BUTLER.idFromName("owner"));
    const now = Date.now();
    const future = now + 86400000;
    const before = await runInDurableObject(stub, (i, s) => {
      i.self.writeDoc("identity", "saved identity A", 0, now);
      i.self.writeDoc("identity", "saved identity B", 1, now);
      i.self.writeDoc("situation", "waiting for an outcome", 0, now);
      const input = {
        id: "erestore",
        facts: "reported result",
        interpretation: "uncertain",
        source: { kind: "task" as const, ref: "t1", excerpt: "host result" },
        occurredAt: now - 100,
      };
      i.self.recordExperience(input, 0, now);
      i.self.recordExperience({ ...input, facts: "corrected report" }, 1, now);
      const wake = new SelfWakeStore(s.storage.sql);
      const state = wake.set(now, now);
      wake.reserve(state.generation, now);
      wake.deferIfGeneration(state.generation, future);
      return {
        identity: i.self.doc("identity"),
        situation: i.self.doc("situation"),
        history: i.self.read({
          kind: "experience",
          id: "erestore",
          history: true,
        }),
        docs: i.self.read({ kind: "identity", history: true }),
        wake: wake.get(),
      };
    });
    await acquire("export");
    const dump = await dumpDo(target);
    await release();
    expect(
      dump.schema.tables.some((t) => t.name === "butler_self_records"),
    ).toBe(true);
    expect(dump.schema.tables.some((t) => t.name === "butler_self_wake")).toBe(
      true,
    );
    setModelOverride(
      scriptedModel([{ text: "later reply" }], { contextWindow: 1000000 }),
    );
    await runInDurableObject(stub, async (i) => {
      i.self.writeDoc("identity", "unwanted later identity", 2, now);
      await (i as unknown as { ensureAgent(): Promise<void> }).ensureAgent();
      await i.harness.submit("message not in the backup", {
        operationId: "tg:after-snapshot",
      });
      await i.harness.wait("tg:after-snapshot");
    });
    await acquire("restore");
    await restoreDo(target, dump);
    await release();
    stub = env.BUTLER.get(env.BUTLER.idFromName("owner"));
    const after = await runInDurableObject(stub, async (i, s) => {
      const wake = new SelfWakeStore(s.storage.sql);
      await (i as unknown as { armSelfWake(): Promise<void> }).armSelfWake();
      await (i as unknown as { armSelfWake(): Promise<void> }).armSelfWake();
      const tool = i.registry
        .snapshot()
        .tools()
        .find((e) => e.tool.name === "read_self")!.tool;
      const sources = await tool.execute(
        { kind: "sources" } as never,
        {} as never,
        {} as never,
      );
      return {
        identity: i.self.doc("identity"),
        situation: i.self.doc("situation"),
        history: i.self.read({
          kind: "experience",
          id: "erestore",
          history: true,
        }),
        docs: i.self.read({ kind: "identity", history: true }),
        wake: wake.get(),
        section: renderSelfSection(i.self, "en"),
        sources: JSON.stringify(sources),
        timers: (await i.listSchedules()).filter(
          (s) => s.callback === "wakeSelf",
        ).length,
      };
    });
    expect(after).toMatchObject(before);
    expect(after.section).toContain("saved identity B");
    expect(after.section).not.toContain("unwanted later identity");
    expect(after.sources).not.toContain("message not in the backup");
    expect(after.timers).toBe(1);
    // Simulate a pre-growth schema. RestoreReset must rebuild empty tables, not reuse stale records.
    const oldNames = new Set(["butler_self_records", "butler_self_wake"]);
    const legacy = {
      schema: {
        ...dump.schema,
        tables: dump.schema.tables.filter((t) => !oldNames.has(t.name)),
      },
      tables: dump.tables.filter((t) => !oldNames.has(t.table.name)),
    };
    await acquire("restore");
    await restoreDo(target, legacy);
    await release();
    stub = env.BUTLER.get(env.BUTLER.idFromName("owner"));
    const empty = await runInDurableObject(stub, (i, s) => ({
      identity: i.self.doc("identity"),
      experiences: i.self.recentExperiences(),
      wake: new SelfWakeStore(s.storage.sql).get(),
      section: renderSelfSection(i.self, "en"),
    }));
    expect(empty.identity).toEqual({
      kind: "identity",
      version: 0,
      content: "",
    });
    expect(empty.experiences).toEqual([]);
    expect(empty.wake.at).toBeNull();
    expect(empty.section).not.toContain("saved identity B");
  });
});
