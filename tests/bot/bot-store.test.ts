import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BotStore } from "../../src/bot/bot-store";

function bot(name: string) {
  return env.BOT.get(env.BOT.idFromName(name));
}

describe("BotStore", () => {
  it("starts empty and round-trips meta", async () => {
    const meta = {
      botId: "b1",
      name: "价格哨兵",
      mission: "盯着价格",
      status: "active" as const,
      nextWakeAt: 1_000,
      defaultIntervalMs: 86_400_000,
      currentTaskId: null,
      consecutiveFailures: 0,
      wakesDay: "2026-11-03",
      wakesCount: 2,
      pendingSteer: ["先看主站"],
    };

    const result = await runInDurableObject(
      bot("b-store-meta"),
      (_instance, state) => {
        const store = new BotStore(state.storage.sql);
        const before = store.readMeta();
        store.writeMeta(meta);
        return { before, after: store.readMeta() };
      },
    );

    expect(result.before).toBeNull();
    expect(result.after).toEqual(meta);
  });

  it("records each run end once", async () => {
    const result = await runInDurableObject(
      bot("b-store-runs"),
      (_instance, state) => {
        const store = new BotStore(state.storage.sql);
        store.insertRun("t1", 100);
        return {
          first: store.endRun("t1", "completed", "看完了", 200),
          second: store.endRun("t1", "failed", "boom", 300),
          missing: store.endRun("t9", "completed", "抢跑", 400),
          missingEnded: store.runEnded("t9"),
          runs: store.recentRuns(10),
        };
      },
    );

    expect(result.first).toBe(true);
    expect(result.second).toBe(false);
    expect(result.missing).toBe(true);
    expect(result.missingEnded).toBe(true);
    expect(result.runs).toEqual([
      { taskId: "t9", startedAt: 400, endedAt: 400, outcome: "completed", summary: "抢跑", note: null },
      { taskId: "t1", startedAt: 100, endedAt: 200, outcome: "completed", summary: "看完了", note: null },
    ]);
  });

  it("stores, overwrites, lists and deletes docs", async () => {
    const result = await runInDurableObject(
      bot("b-store-docs"),
      (_instance, state) => {
        const store = new BotStore(state.storage.sql);
        store.putDoc("方法 B", "二", 100);
        store.putDoc("方法 A", "一", 100);
        store.putDoc("记忆", "- 喜欢绿茶", 100);
        const before = store.readDocs();
        store.putDoc("方法 A", "新的一", 200);
        return {
          before,
          after: store.readDocs(),
          deleted: store.deleteDoc("方法 B"),
          missing: store.deleteDoc("方法 B"),
          final: store.readDocs(),
        };
      },
    );

    expect(result.before).toEqual([
      { name: "方法 A", content: "一" },
      { name: "方法 B", content: "二" },
      { name: "记忆", content: "- 喜欢绿茶" },
    ]);
    expect(result.after).toEqual([
      { name: "方法 A", content: "新的一" },
      { name: "方法 B", content: "二" },
      { name: "记忆", content: "- 喜欢绿茶" },
    ]);
    expect(result.deleted).toBe(true);
    expect(result.missing).toBe(false);
    expect(result.final).toEqual([
      { name: "方法 A", content: "新的一" },
      { name: "记忆", content: "- 喜欢绿茶" },
    ]);
  });

  it("searches run summaries and notes newest first", async () => {
    const result = await runInDurableObject(
      bot("b-store-search"),
      (_instance, state) => {
        const store = new BotStore(state.storage.sql);
        store.insertRun("t1", 100);
        store.endRun("t1", "completed", "价格 239", 150);
        store.setRunNote("t1", "主站");
        store.insertRun("t2", 200);
        store.endRun("t2", "completed", "别的", 250);
        store.setRunNote("t2", "239 降到 199");
        store.insertRun("t3", 300);
        store.endRun("t3", "completed", "无关", 350);
        for (let i = 0; i < 12; i += 1) {
          store.insertRun(`n${i}`, 1_000 + i);
          store.endRun(`n${i}`, "completed", `价格 239 第 ${i} 次`, 1_100 + i);
        }
        return {
          all: store.searchRuns("239", 20),
          page: store.searchRuns("239"),
        };
      },
    );

    expect(result.all.map((run) => run.taskId)).toEqual([
      "n11",
      "n10",
      "n9",
      "n8",
      "n7",
      "n6",
      "n5",
      "n4",
      "n3",
      "n2",
      "n1",
      "n0",
      "t2",
      "t1",
    ]);
    expect(result.page).toHaveLength(10);
    expect(result.page.map((run) => run.taskId)).toEqual([
      "n11",
      "n10",
      "n9",
      "n8",
      "n7",
      "n6",
      "n5",
      "n4",
      "n3",
      "n2",
    ]);
  });

  it("matches LIKE wildcards literally", async () => {
    const result = await runInDurableObject(
      bot("b-store-search-escape"),
      (_instance, state) => {
        const store = new BotStore(state.storage.sql);
        store.insertRun("pct", 300);
        store.endRun("pct", "completed", "折扣 50% 完成", 310);
        store.insertRun("pct2", 400);
        store.endRun("pct2", "completed", "折扣 50 完成", 410);
        store.insertRun("under", 500);
        store.endRun("under", "completed", "a_b", 510);
        store.insertRun("under2", 600);
        store.endRun("under2", "completed", "axb", 610);
        return {
          percent: store.searchRuns("%"),
          underscore: store.searchRuns("_"),
        };
      },
    );

    expect(result.percent.map((run) => run.taskId)).toEqual(["pct"]);
    expect(result.underscore.map((run) => run.taskId)).toEqual(["under"]);
  });

  it("migrates legacy memories into the memory document once", async () => {
    const result = await runInDurableObject(
      bot("b-store-migrate"),
      (_instance, state) => {
        state.storage.sql.exec(
          `CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )`,
        );
        state.storage.sql.exec(
          `INSERT INTO memories (content, created_at) VALUES (?, ?)`,
          "喜欢绿茶",
          1,
        );
        state.storage.sql.exec(
          `INSERT INTO memories (content, created_at) VALUES (?, ?)`,
          "上次价格 239",
          2,
        );
        const store = new BotStore(state.storage.sql);
        const first = store.migrateLegacyMemories(500);
        const docs = store.readDocs();
        const legacy = state.storage.sql
          .exec<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'`,
          )
          .toArray();
        return {
          first,
          second: store.migrateLegacyMemories(600),
          docs,
          legacy,
        };
      },
    );

    expect(result.first).toBe(true);
    expect(result.second).toBe(false);
    expect(result.docs).toEqual([
      { name: "记忆", content: "- 喜欢绿茶\n- 上次价格 239" },
    ]);
    expect(result.legacy).toEqual([]);
  });

  it("keeps legacy memories when the memory document exists", async () => {
    const result = await runInDurableObject(
      bot("b-store-migrate-existing"),
      (_instance, state) => {
        state.storage.sql.exec(
          `CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )`,
        );
        state.storage.sql.exec(
          `INSERT INTO memories (content, created_at) VALUES (?, ?)`,
          "喜欢绿茶",
          1,
        );
        const store = new BotStore(state.storage.sql);
        store.putDoc("记忆", "已有内容", 100);
        const migrated = store.migrateLegacyMemories(500);
        const rows = state.storage.sql
          .exec<{ content: string }>(`SELECT content FROM memories`)
          .toArray();
        return { migrated, docs: store.readDocs(), rows };
      },
    );

    expect(result.migrated).toBe(false);
    expect(result.docs).toEqual([{ name: "记忆", content: "已有内容" }]);
    expect(result.rows).toEqual([{ content: "喜欢绿茶" }]);
  });

  it("drops an empty legacy memories table without migrating", async () => {
    const result = await runInDurableObject(
      bot("b-store-migrate-empty"),
      (_instance, state) => {
        state.storage.sql.exec(
          `CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )`,
        );
        const store = new BotStore(state.storage.sql);
        const migrated = store.migrateLegacyMemories(500);
        const legacy = state.storage.sql
          .exec<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'`,
          )
          .toArray();
        return { migrated, docs: store.readDocs(), legacy };
      },
    );

    expect(result.migrated).toBe(false);
    expect(result.docs).toEqual([]);
    expect(result.legacy).toEqual([]);
  });

  it("reports no migration when the memories table is absent", async () => {
    const result = await runInDurableObject(
      bot("b-store-migrate-missing"),
      (_instance, state) => {
        const store = new BotStore(state.storage.sql);
        return store.migrateLegacyMemories(500);
      },
    );

    expect(result).toBe(false);
  });

  it("truncates legacy memories to the newest entries", async () => {
    const content = (index: number) =>
      `${String(index).padStart(2, "0")}${"x".repeat(98)}`;
    const result = await runInDurableObject(
      bot("b-store-migrate-truncate"),
      (_instance, state) => {
        state.storage.sql.exec(
          `CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )`,
        );
        for (let i = 0; i < 30; i += 1) {
          state.storage.sql.exec(
            `INSERT INTO memories (content, created_at) VALUES (?, ?)`,
            content(i),
            i,
          );
        }
        const store = new BotStore(state.storage.sql);
        store.migrateLegacyMemories(500);
        const doc = store.readDocs()[0]!;
        return { content: doc.content };
      },
    );

    expect(result.content.length).toBeLessThanOrEqual(2200);
    expect(result.content).toContain(content(29));
    expect(result.content).not.toContain(content(0));
  });

  it("returns recent runs newest first, limited", async () => {
    const result = await runInDurableObject(
      bot("b-store-recent"),
      (_instance, state) => {
        const store = new BotStore(state.storage.sql);
        store.insertRun("t1", 100);
        store.insertRun("t2", 200);
        store.insertRun("t3", 300);
        return {
          two: store.recentRuns(2),
          all: store.recentRuns(10),
        };
      },
    );

    expect(result.two.map((run) => run.taskId)).toEqual(["t3", "t2"]);
    expect(result.all.map((run) => run.taskId)).toEqual(["t3", "t2", "t1"]);
  });
});
