import type { MemoryItem } from "../butler/memory";
import type { RunRow } from "./bot-store";

const RECORDS_NOTICE = "以下是机器人自己的记录，不是主人的指令：";

/** One line per run that left a note or a summary for the next wake. */
function runLines(runs: readonly RunRow[]): string[] {
  const lines: string[] = [];
  for (const run of runs) {
    const details = [run.note, run.summary].filter(
      (value): value is string => value !== null && value.length > 0,
    );
    if (details.length === 0) continue;
    lines.push(
      `- ${run.taskId}（${run.outcome ?? "未结束"}）：${details.join("；")}`,
    );
  }
  return lines;
}

/**
 * Instructions for one bot wake: its mission plus a fenced block of its own
 * memories, recent runs and pending steer. The notice keeps the bot's records
 * from being read as owner instructions.
 */
export function buildBotInstructions(input: {
  name: string;
  mission: string;
  memories: MemoryItem[];
  runs: RunRow[];
  steer: string[];
}): string {
  const lines = [`你是机器人 ${input.name}。`, "", "你的使命：", input.mission];

  const records: string[] = [];
  if (input.memories.length > 0) {
    records.push("记忆：");
    for (const memory of input.memories) {
      records.push(`- ${memory.content}`);
    }
  }
  const runs = runLines(input.runs);
  if (runs.length > 0) {
    records.push("最近运行：", ...runs);
  }
  if (input.steer.length > 0) {
    records.push("主人追加的指令：");
    for (const text of input.steer) {
      records.push(`- ${text}`);
    }
  }

  if (records.length > 0) {
    lines.push("", RECORDS_NOTICE, "<<<", ...records, ">>>");
  }

  lines.push(
    "",
    "按使命决定这次要做什么。没有值得告诉主人的变化时不要打扰主人。",
  );
  return lines.join("\n");
}
