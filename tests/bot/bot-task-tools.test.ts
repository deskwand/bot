import { describe, expect, it } from "vitest";
import {
  createBotTaskTools,
  type BotControl,
} from "../../src/bot/bot-tools";
import type { RunRow } from "../../src/bot/bot-store";
import {
  rejectionText,
  type ApprovalDecision,
  type ApprovalGateLike,
} from "../../src/task/approvals";

type WriteCall = {
  name: string;
  content: string;
  options: { allowRules: boolean };
};

type FakeBot = {
  control: BotControl;
  writes: WriteCall[];
  searches: string[];
  runs: RunRow[];
};

function fakeBot(): FakeBot {
  const writes: WriteCall[] = [];
  const searches: string[] = [];
  const state: FakeBot = {
    writes,
    searches,
    runs: [],
    control: {
      async writeDoc(name, content, options) {
        writes.push({ name, content, options });
        return { ok: true, message: `已写入「${name}」` };
      },
      async searchRuns(keyword) {
        searches.push(keyword);
        return state.runs;
      },
      async setNextWake() {
        return { at: 0, clamped: false };
      },
      async note() {},
      async finish() {},
    },
  };
  return state;
}

type FakeGate = {
  gate: ApprovalGateLike;
  requests: { tool: string; args: unknown }[];
  signals: AbortSignal[];
};

function fakeGate(decision: ApprovalDecision): FakeGate {
  const requests: { tool: string; args: unknown }[] = [];
  const signals: AbortSignal[] = [];
  return {
    requests,
    signals,
    gate: {
      async request(tool, args, signal) {
        requests.push({ tool, args });
        signals.push(signal);
        return decision;
      },
      async resolve() {
        return { ok: true, message: "" };
      },
    },
  };
}

function toolsFor(
  bot: BotControl,
  gate: ApprovalGateLike,
) {
  return createBotTaskTools({
    bot,
    taskId: () => "t1",
    notify: async () => true,
    approvals: gate,
  });
}

async function run(
  tools: ReturnType<typeof toolsFor>,
  name: string,
  args: Record<string, unknown>,
  signal = new AbortController().signal,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(args as never, {} as never, {
    abortSignal: signal,
  } as never);
}

function text(outcome: {
  output?: { type: string; text?: string }[];
}): string {
  return (outcome.output?.[0] as { text: string }).text;
}

describe("bot task tools", () => {
  it("lists exactly the bot tools", () => {
    const tools = toolsFor(fakeBot().control, fakeGate("approved").gate);

    expect(tools.map((tool) => tool.name)).toEqual([
      "write_doc",
      "propose_rules",
      "search_runs",
      "bot_note",
      "set_next_wake",
      "notify_owner",
      "finish_bot",
    ]);
  });

  it("write_doc passes the arguments through", async () => {
    const bot = fakeBot();
    const tools = toolsFor(bot.control, fakeGate("approved").gate);

    const result = await run(tools, "write_doc", {
      name: "记忆",
      content: "- 喜欢绿茶",
    });

    expect(text(result)).toBe("已写入「记忆」");
    expect(bot.writes).toEqual([
      {
        name: "记忆",
        content: "- 喜欢绿茶",
        options: { allowRules: false },
      },
    ]);
  });

  it("propose_rules writes the approved rules", async () => {
    const bot = fakeBot();
    const approval = fakeGate("approved");
    const tools = toolsFor(bot.control, approval.gate);

    const result = await run(tools, "propose_rules", {
      content: "凌晨不发消息",
      reason: "吵到主人",
    });

    expect(text(result)).toBe("已写入「守则」");
    expect(approval.requests).toEqual([
      {
        tool: "propose_rules",
        args: { content: "凌晨不发消息", reason: "吵到主人" },
      },
    ]);
    expect(bot.writes).toEqual([
      {
        name: "守则",
        content: "凌晨不发消息",
        options: { allowRules: true },
      },
    ]);
  });

  it("propose_rules trims content for the card and the write", async () => {
    const bot = fakeBot();
    const approval = fakeGate("approved");
    const tools = toolsFor(bot.control, approval.gate);

    await run(tools, "propose_rules", {
      content: "\n\n  凌晨不发消息  \n",
      reason: "吵到主人",
    });

    expect(approval.requests).toEqual([
      {
        tool: "propose_rules",
        args: { content: "凌晨不发消息", reason: "吵到主人" },
      },
    ]);
    expect(bot.writes).toEqual([
      {
        name: "守则",
        content: "凌晨不发消息",
        options: { allowRules: true },
      },
    ]);
  });

  it("propose_rules throws when the run is aborted during approval", async () => {
    const bot = fakeBot();
    const tools = toolsFor(bot.control, fakeGate("rejected").gate);
    const controller = new AbortController();
    controller.abort();

    await expect(
      run(
        tools,
        "propose_rules",
        { content: "凌晨不发消息", reason: "吵到主人" },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(bot.writes).toEqual([]);
  });

  it.each(["rejected", "expired"] as const)(
    "propose_rules does nothing when %s",
    async (decision) => {
      const bot = fakeBot();
      const tools = toolsFor(bot.control, fakeGate(decision).gate);

      const result = await run(tools, "propose_rules", {
        content: "凌晨不发消息",
        reason: "吵到主人",
      });

      expect(result.isError).toBe(true);
      expect(text(result)).toBe(rejectionText(decision));
      expect(bot.writes).toEqual([]);
    },
  );

  it("propose_rules rejects an over-long proposal without asking", async () => {
    const bot = fakeBot();
    const approval = fakeGate("approved");
    const tools = toolsFor(bot.control, approval.gate);

    const result = await run(tools, "propose_rules", {
      content: "x".repeat(2001),
      reason: "太长",
    });

    expect(approval.requests).toEqual([]);
    expect(bot.writes).toEqual([]);
    const message = text(result);
    expect(message).toContain("2001");
    expect(message).toContain("2000");
  });

  it("search_runs formats notes and summaries", async () => {
    const bot = fakeBot();
    bot.runs = [
      {
        taskId: "t2",
        startedAt: Date.UTC(2030, 0, 1, 9, 0, 0),
        endedAt: Date.UTC(2030, 0, 1, 10, 0, 0),
        outcome: "completed",
        summary: "价格没变",
        note: "明早再看",
      },
      {
        taskId: "t1",
        startedAt: Date.UTC(2029, 11, 31, 9, 0, 0),
        endedAt: null,
        outcome: null,
        summary: null,
        note: null,
      },
    ];
    const tools = toolsFor(bot.control, fakeGate("approved").gate);

    const result = await run(tools, "search_runs", { keyword: "价格" });

    expect(bot.searches).toEqual(["价格"]);
    expect(text(result)).toBe(
      [
        "- t2 2030-01-01T09:00:00.000Z（completed）：明早再看；价格没变",
        "- t1 2029-12-31T09:00:00.000Z（未结束）：",
      ].join("\n"),
    );
  });

  it("search_runs clamps each detail and handles no matches", async () => {
    const bot = fakeBot();
    const long = "x".repeat(600);
    bot.runs = [
      {
        taskId: "t1",
        startedAt: 0,
        endedAt: null,
        outcome: "failed",
        summary: long,
        note: long,
      },
    ];
    const tools = toolsFor(bot.control, fakeGate("approved").gate);

    const result = await run(tools, "search_runs", { keyword: "x" });
    expect(text(result)).not.toContain(long);
    expect(text(result)).toContain(`${"x".repeat(500)}…`);

    bot.runs = [];
    const empty = await run(tools, "search_runs", { keyword: "x" });
    expect(text(empty)).toBe("没有匹配的运行记录");
  });
});
