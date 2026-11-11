import type { TranscriptContext } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClockOverride } from "../../src/butler/notifier";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const MINUTE = 60_000;
const START = Date.UTC(2030, 0, 1, 9, 0, 0);

let now = START;

beforeEach(async () => {
  now = START;
  setClockOverride({
    now: () => now,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  await seedOwnerAddress("42");
});

afterEach(() => {
  setClockOverride(null);
  setChannelOverride("telegram", null);
  setModelOverride(null);
  vi.restoreAllMocks();
});

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

type ButlerStub = ReturnType<typeof butler>;

async function seedTask(
  stub: ButlerStub,
  row: {
    id?: string;
    title?: string;
    status?: string;
    botId?: string | null;
    ageMs?: number;
    lastProgress?: string | null;
  } = {},
): Promise<void> {
  const createdAt = now - (row.ageMs ?? 0);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO tasks
        (id, title, status, created_at, updated_at, chat_id, artifacts_json,
         last_seq, bot_id, last_progress, last_progress_at, handle)
       VALUES (?, ?, ?, ?, ?, '42', '[]', 0, ?, ?, ?, ?)`,
      row.id ?? "t1",
      row.title ?? "查机票",
      row.status ?? "running",
      createdAt,
      createdAt,
      row.botId ?? null,
      row.lastProgress ?? null,
      row.lastProgress === null || row.lastProgress === undefined
        ? null
        : createdAt,
      row.botId == null ? 1 : null,
    );
  });
}

/** The last user message the model saw, as plain text. */
function lastUserText(
  context: TranscriptContext | undefined,
): string | undefined {
  const last = context?.messages
    .filter((entry) => entry.role === "user")
    .at(-1);
  if (last === undefined) return undefined;
  if (typeof last.content === "string") return last.content;
  return last.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("ButlerDO.healSlowTasks", () => {
  it("counts three minutes from a retry's start, not from creation", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const stub = butler("slow-retry");
    await seedTask(stub, { status: "failed", ageMs: 60 * MINUTE });

    await stub.report({ taskId: "t1", seq: 1, type: "started" });
    await stub.healSlowTasks();
    expect(channel.sent).toEqual([]);

    now += 3 * MINUTE;
    await stub.healSlowTasks();
    expect(channel.sent.map((message) => message.text)).toEqual([
      "「查机票」还在办。",
    ]);
  });

  it("says nothing before three minutes", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ text: "还在查机票。" }]));
    const stub = butler("slow-early");
    await seedTask(stub, {
      ageMs: 3 * MINUTE - 1_000,
      lastProgress: "正在搜索 机票",
    });

    await stub.healSlowTasks();

    expect(channel.sent).toEqual([]);
  });

  it("says one line at three minutes with the last progress", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let seen: TranscriptContext | undefined;
    setModelOverride(
      scriptedModel([
        {
          text: "机票还在查，找到合适的就跟你说。",
          observe: (context) => {
            seen = context;
          },
        },
      ]),
    );
    const stub = butler("slow-once");
    await seedTask(stub, {
      ageMs: 3 * MINUTE,
      lastProgress: "正在搜索 机票",
    });

    await stub.healSlowTasks();

    expect(channel.sent.map((message) => message.text)).toEqual([
      "机票还在查，找到合适的就跟你说。",
    ]);
    expect(lastUserText(seen)).toContain("正在搜索 机票");
  });

  it("does not repeat within fifteen minutes", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ text: "机票还在查。" }]));
    const stub = butler("slow-repeat-later");
    await seedTask(stub, {
      ageMs: 3 * MINUTE,
      lastProgress: "正在搜索 机票",
    });

    await stub.healSlowTasks();
    now += MINUTE;
    await stub.healSlowTasks();

    expect(channel.sent).toHaveLength(1);
  });

  it("reminds again fifteen minutes after the last one", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([{ text: "机票还在查。" }, { text: "机票还没有结果。" }]),
    );
    const stub = butler("slow-repeat");
    await seedTask(stub, {
      ageMs: 3 * MINUTE,
      lastProgress: "正在搜索 机票",
    });

    await stub.healSlowTasks();
    now += 15 * MINUTE;
    await stub.healSlowTasks();

    expect(channel.sent.map((message) => message.text)).toEqual([
      "机票还在查。",
      "机票还没有结果。",
    ]);
  });

  it("says nothing about a task that already completed", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const observe = vi.fn();
    setModelOverride(scriptedModel([{ text: "不应出现", observe }]));
    const stub = butler("slow-completed");
    await seedTask(stub, { status: "completed", ageMs: 5 * MINUTE });

    await stub.healSlowTasks();

    expect(channel.sent).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
  });

  it("says nothing about a bot task", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const observe = vi.fn();
    setModelOverride(scriptedModel([{ text: "不应出现", observe }]));
    const stub = butler("slow-bot-task");
    await seedTask(stub, {
      botId: "b1",
      ageMs: 10 * MINUTE,
      lastProgress: "正在读行情",
    });

    await stub.healSlowTasks();

    expect(channel.sent).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
  });

  it("says nothing while the maintenance lease is active", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    const observe = vi.fn();
    setModelOverride(scriptedModel([{ text: "不应出现", observe }]));
    const stub = butler("slow-maintenance");
    await stub.acquireMaintenance("export", "test-op");
    await seedTask(stub, {
      ageMs: 10 * MINUTE,
      lastProgress: "正在搜索 机票",
    });

    await stub.healSlowTasks();

    expect(channel.sent).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
  });
});
