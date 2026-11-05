import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ButlerDO } from "../../src/butler/butler-do";
import { TasksRepo } from "../../src/butler/tasks-repo";
import { ChannelDO } from "../../src/channels/channel-do";
import { setChannelOverride } from "../../src/channels/override";
import type { OutboundMessage } from "../../src/protocol";
import { fakeChannel } from "../helpers/fake-channel";
import { seedOwnerAddress } from "../helpers/channel-ref";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function butlerStub(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function channelStub(name: string) {
  return env.CHANNELS.get(env.CHANNELS.idFromName(name));
}

afterEach(() => {
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  vi.restoreAllMocks();
});

/** The task/approval schema a release before this plan shipped. */
function createLegacyButlerSchema(sql: SqlStorage): void {
  sql.exec(`DROP TABLE IF EXISTS tasks`);
  sql.exec(`DROP TABLE IF EXISTS task_events`);
  sql.exec(`DROP TABLE IF EXISTS meta`);
  sql.exec(`DROP TABLE IF EXISTS approval_messages`);
  sql.exec(`DROP TABLE IF EXISTS memories`);
  sql.exec(`DROP TABLE IF EXISTS schedules`);
  sql.exec(`DROP TABLE IF EXISTS schedules_meta`);

  sql.exec(
    `CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      chat_id TEXT,
      progress_message_id TEXT,
      summary TEXT,
      artifacts_json TEXT,
      last_seq INTEGER NOT NULL DEFAULT 0
    )`,
  );
  sql.exec(
    `CREATE TABLE task_events (
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (task_id, seq)
    )`,
  );
  sql.exec(
    `CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  );
  sql.exec(
    `CREATE TABLE approval_messages (
      approval_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      text TEXT NOT NULL
    )`,
  );
  sql.exec(
    `CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
  sql.exec(
    `CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      cron TEXT NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      chat_id TEXT,
      agent_schedule_id TEXT,
      created_at INTEGER NOT NULL
    )`,
  );
  sql.exec(
    `CREATE TABLE schedules_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  );
}

describe("migration from the previous schema", () => {
  it("keeps tasks, memory, schedules, approvals and the id counter", async () => {
    const stub = butlerStub("migration-butler");
    const result = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      createLegacyButlerSchema(sql);

      sql.exec(
        `INSERT INTO tasks
          (id, title, status, created_at, updated_at, chat_id,
           progress_message_id, summary, artifacts_json, last_seq)
         VALUES ('t7', '旧任务', 'running', 1, 2, NULL, '77', NULL, '[]', 0)`,
      );
      sql.exec(`INSERT INTO meta (key, value) VALUES ('task_counter', '7')`);
      sql.exec(
        `INSERT INTO memories (content, created_at) VALUES ('旧记忆', 1)`,
      );
      sql.exec(
        `INSERT INTO schedules
          (id, cron, title, instructions, chat_id, agent_schedule_id, created_at)
         VALUES ('s1', '0 1 * * *', '早报', '汇总', NULL, NULL, 1)`,
      );
      sql.exec(
        `INSERT INTO approval_messages
          (approval_id, task_id, message_id, text)
         VALUES ('ap1', 't7', '77', '旧审批')`,
      );

      // The upgrade runs the object's real constructor over the old storage.
      new ButlerDO(state, env as Env);

      const columns = (table: string) =>
        sql
          .exec<{ name: string }>(`PRAGMA table_info(${table})`)
          .toArray()
          .map((row) => row.name);

      return {
        taskColumns: columns("tasks"),
        approvalColumns: columns("approval_messages"),
        task: sql
          .exec(
            `SELECT id, title, status, progress_message_id,
                    progress_message_ref_json
             FROM tasks WHERE id = 't7'`,
          )
          .toArray()[0],
        approval: sql
          .exec(
            `SELECT approval_id, message_id, message_ref_json
             FROM approval_messages WHERE approval_id = 'ap1'`,
          )
          .toArray()[0],
        memories: sql.exec(`SELECT content FROM memories`).toArray(),
        schedules: sql
          .exec(`SELECT id, cron, title FROM schedules`)
          .toArray(),
        nextId: new TasksRepo(sql).nextId(),
      };
    });

    expect(result.taskColumns).toContain("progress_message_ref_json");
    expect(result.approvalColumns).toContain("message_ref_json");
    // Old rows survive untouched; the bare id is not turned into a ref.
    expect(result.task).toEqual({
      id: "t7",
      title: "旧任务",
      status: "running",
      progress_message_id: "77",
      progress_message_ref_json: null,
    });
    expect(result.approval).toEqual({
      approval_id: "ap1",
      message_id: "77",
      message_ref_json: null,
    });
    expect(result.memories).toEqual([{ content: "旧记忆" }]);
    expect(result.schedules).toEqual([
      { id: "s1", cron: "0 1 * * *", title: "早报" },
    ]);
    // Task ids never restart: the counter was preserved.
    expect(result.nextId).toBe("t8");
  });

  it("sends a new progress message instead of editing a legacy bare id", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    await seedOwnerAddress("42");

    const stub = butlerStub("migration-progress");
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      createLegacyButlerSchema(sql);
      sql.exec(
        `INSERT INTO tasks
          (id, title, status, created_at, updated_at, chat_id,
           progress_message_id, summary, artifacts_json, last_seq)
         VALUES ('t7', '旧任务', 'running', 1, 2, NULL, '77', NULL, '[]', 0)`,
      );

      const upgraded = new ButlerDO(state, env as Env);
      await upgraded.report({
        taskId: "t7",
        seq: 1,
        type: "progress",
        text: "继续",
      });
    });

    expect(channel.edits).toEqual([]);
    expect(channel.sent).toEqual([
      {
        chatId: "42",
        text: "⏳ t7 旧任务：继续",
        buttons: [
          [{ label: "取消", data: "a:cancel:t7", hint: "取消 t7" }],
        ],
      },
    ]);
  });

  it("keeps WeChat conversation state while the default selection is Telegram", async () => {
    const hub = channelStub("migration-channel");
    const result = await runInDurableObject(hub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DELETE FROM owner_addresses");
      sql.exec("DELETE FROM wechat_state");
      sql.exec("DELETE FROM wechat_contexts");
      sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES ('telegram', '42', 1)`,
      );
      sql.exec(
        `INSERT INTO wechat_state
           (credentials_hash, cursor, status, last_poll_at, expiry_notified)
         VALUES ('hash-a', 'cursor-1', 'running', 1, 0)`,
      );
      sql.exec(
        `INSERT INTO wechat_contexts (user_id, context_token, updated_at)
         VALUES ('wx-owner', 'ctx-1', 1)`,
      );

      // No ACTIVE_CHANNEL var: the documented default is Telegram.
      const upgraded = new ChannelDO(state, {
        ...(env as unknown as Env),
        ACTIVE_CHANNEL: undefined,
        WECHAT_CREDENTIALS: undefined,
        CF_VERSION_METADATA: { id: "migration-v1" },
      } as Env);

      const route = await upgraded.currentRoute();
      await upgraded.ensurePolling();

      return {
        route,
        state: sql
          .exec(
            `SELECT credentials_hash, cursor, status FROM wechat_state LIMIT 1`,
          )
          .toArray()[0],
        contexts: sql
          .exec(`SELECT user_id, context_token FROM wechat_contexts`)
          .toArray(),
        polls: (await upgraded.listSchedules()).filter(
          (schedule) => schedule.callback === "pollWeChat",
        ),
      };
    });

    expect(result.route.channel).toBe("telegram");
    expect(result.state).toEqual({
      credentials_hash: "hash-a",
      cursor: "cursor-1",
      status: "stopped",
    });
    expect(result.contexts).toEqual([
      { user_id: "wx-owner", context_token: "ctx-1" },
    ]);
    // Nothing selected WeChat, so no chain keeps running.
    expect(result.polls).toEqual([]);
  });

  it("disables business traffic for an invalid value without falling back", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const hub = channelStub("migration-invalid");
    const result = await runInDurableObject(hub, async (_instance, state) => {
      const upgraded = new ChannelDO(state, {
        ...(env as unknown as Env),
        ACTIVE_CHANNEL: "sms",
        CF_VERSION_METADATA: { id: "migration-v1" },
      } as Env);

      const route = await upgraded.currentRoute();
      const sendOutcome = await upgraded
        .sendCurrent({ text: "n" })
        .then(
          () => "sent",
          (sendError: Error) => sendError.message,
        );
      await upgraded.ensurePolling();
      return {
        route,
        sendOutcome,
        polls: (await upgraded.listSchedules()).filter(
          (schedule) => schedule.callback === "pollWeChat",
        ),
      };
    });

    expect(result.route).toEqual({ channel: null, routeKey: "disabled" });
    expect(result.sendOutcome).toBe("channel selection disabled");
    expect(result.polls).toEqual([]);
    expect(error).toHaveBeenCalled();
  });

  it("does not edit a reference issued before the upgrade when the selection is unchanged", async () => {
    const edits: OutboundMessage[] = [];
    setChannelOverride("telegram", {
      parseInbound: async () => null,
      async send() {
        return { messageId: "10" };
      },
      async edit(_to, _messageId, msg) {
        edits.push(msg);
      },
      async answerAction() {},
    });

    const hub = channelStub("migration-refs");
    const result = await runInDurableObject(hub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DELETE FROM owner_addresses");
      sql.exec(
        `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
         VALUES ('telegram', '42', 1)`,
      );

      const before = new ChannelDO(state, {
        ...(env as unknown as Env),
        ACTIVE_CHANNEL: "telegram",
        CF_VERSION_METADATA: { id: "migration-v1" },
      } as Env);
      const ref = await before.sendCurrent({ text: "progress" });

      const after = new ChannelDO(state, {
        ...(env as unknown as Env),
        ACTIVE_CHANNEL: "telegram",
        CF_VERSION_METADATA: { id: "migration-v2" },
      } as Env);
      return {
        ref,
        edited: await after.editCurrent(ref, { text: "next" }),
      };
    });

    // Same channel, new deployment: the old reference cannot be reused.
    expect(result.ref.channel).toBe("telegram");
    expect(result.edited).toBe(false);
    expect(edits).toEqual([]);
  });
});
