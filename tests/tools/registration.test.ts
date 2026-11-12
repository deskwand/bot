import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotChatDO } from "../../src/bot/bot-chat-do";
import { ButlerDO } from "../../src/butler/butler-do";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

function setEnv(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!savedEnv.has(key)) savedEnv.set(key, ENV[key]);
    ENV[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete ENV[key];
    else ENV[key] = value;
  }
  savedEnv.clear();
}

beforeEach(() => {
  setChannelOverride("telegram", fakeChannel().adapter);
});

afterEach(() => {
  setModelOverride(null);
  setChannelOverride("telegram", null);
  vi.restoreAllMocks();
  restoreEnv();
});

function butler() {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

describe("BotChatDO execution tools", () => {
  it("installs no wallet tools", async () => {
    const stub = env.BOT_CHAT.get(env.BOT_CHAT.idFromName("t-wallet-registry"));

    const names = await runInDurableObject(stub, (instance: BotChatDO) =>
      instance.registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name),
    );

    expect(names.filter((name) => name.startsWith("wallet_"))).toEqual([]);
  });
});

describe("TaskDO execution tools", () => {
  it("installs web_search, web_fetch and save_artifact", async () => {
    const stub = env.TASK.get(env.TASK.idFromName("t-tools-registry"));

    const names = await runInDurableObject(stub, (instance) =>
      instance.registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name),
    );

    expect(names).toEqual(
      expect.arrayContaining([
        "finish_task",
        "web_search",
        "web_fetch",
        "save_artifact",
        "now",
        "get_artifact",
        "http_request",
      ]),
    );
    expect(names.filter((name) => name.startsWith("life_"))).toEqual([]);
    expect(names.filter((name) => name.startsWith("wallet_"))).toEqual([]);
  });

  it("reports save_artifact progress to the Butler without the outbox", async () => {
    const progress = vi.spyOn(ButlerDO.prototype, "reportTaskProgress");
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "save_artifact",
              args: { filename: "report.md", content: "# body" },
            },
          ],
        },
        { toolCalls: [{ name: "finish_task", args: { summary: "saved" } }] },
      ]),
    );
    const taskId = "t-tool-progress";
    const stub = env.TASK.get(env.TASK.idFromName(taskId));

    await stub.start({
      taskId,
      title: "Tool progress",
      instructions: "save a report",
    });

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
      },
      { timeout: 10_000 },
    );
    expect(progress.mock.calls).toEqual([
      [taskId, "保存：report.md"],
      [taskId, "保存：report.md ✓"],
    ]);

    // Progress is display-only: it leaves no durable rows in the Task DO.
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM events WHERE type = 'progress'`,
        )
        .toArray()[0]?.count,
    );
    expect(stored).toBe(0);
  });

  it("uses the localized invalid URL label in an English progress line", async () => {
    setEnv({
      DESKWAND_CONFIG: {
        schemaVersion: 1,
        locale: "en",
        owner: { telegramUserIds: [100000001] },
        models: {
          butler: { provider: "deepseek", id: "deepseek-flash" },
          task: { provider: "deepseek", id: "deepseek-flash" },
        },
        mcpServers: [],
      },
    });
    const progress = vi.spyOn(ButlerDO.prototype, "reportTaskProgress");
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "get_artifact", args: { ref: "http://[" } }] },
        { toolCalls: [{ name: "finish_task", args: { summary: "done" } }] },
      ]),
    );
    const taskId = "t-tool-invalid-url";
    const stub = env.TASK.get(env.TASK.idFromName(taskId));

    await stub.start({
      taskId,
      title: "Invalid URL",
      instructions: "read an invalid artifact",
    });

    await vi.waitFor(
      async () => {
        const events = await butler().debugEvents(taskId);
        expect(events.map((event) => event.type)).toEqual([
          "started",
          "completed",
        ]);
      },
      { timeout: 10_000 },
    );
    expect(progress.mock.calls).toContainEqual([
      taskId,
      "Read artifact: [invalid URL]",
    ]);
  });
});
