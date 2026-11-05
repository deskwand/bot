import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { BotInit, BotSnapshot } from "../bot/bot-do";
import { clampWakeAt, parseDuration } from "../bot/wake";
import type { BotsRepo } from "./bots-repo";
import { RENDER_LIMIT } from "./memory";
import { getClock } from "./notifier";
import type { TaskControl } from "./tools";

export type { TaskControl };

const DURATION_HINT = "（示例：30m、2h、1d）";

const CreateBot = Type.Object({
  name: Type.String(),
  mission: Type.String(),
  default_interval: Type.String(),
  first_wake_after: Type.Optional(Type.String()),
});

const BotId = Type.Object({ id: Type.String() });

const SteerBot = Type.Object({ id: Type.String(), text: Type.String() });

const ResumeBot = Type.Object({
  id: Type.String(),
  wake_now: Type.Optional(Type.Boolean()),
});

const ListBots = Type.Object({});

const RenameBot = Type.Object({ id: Type.String(), name: Type.String() });

/** The Bot DO operations the management tools call. */
export type BotControl = {
  init(spec: BotInit): Promise<void>;
  snapshot(): Promise<BotSnapshot | null>;
  steer(text: string): Promise<{ currentTaskId: string | null }>;
  wakeNow(): Promise<"scheduled" | "after_run" | "inactive">;
  pause(): Promise<void>;
  resume(wakeNow: boolean): Promise<void>;
  rename(name: string): Promise<boolean>;
  destroy(): Promise<void>;
};

export type BotToolDeps = {
  bots: BotsRepo;
  bot(id: string): BotControl;
  task(id: string): TaskControl;
};

function output(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function durationError(text: string): string {
  return `时长格式无效：${text}${DURATION_HINT}`;
}

/**
 * The Butler's bot management tools. Like the control tools they always
 * answer with text and never throw: the model explains failures to the owner.
 */
export function createBotTools(deps: BotToolDeps): ToolRegistration[] {
  const { bots, bot, task } = deps;

  const createBot: ToolRegistration<typeof CreateBot> = {
    name: "create_bot",
    description:
      "Create a long-lived bot that keeps working on a recurring mission and wakes itself up.",
    parameters: CreateBot,
    async execute({ name, mission, default_interval, first_wake_after }) {
      try {
        const intervalMs = parseDuration(default_interval);
        if (intervalMs === null) return output(durationError(default_interval));

        const now = getClock().now();
        let firstWakeAt = now;
        if (first_wake_after !== undefined) {
          const afterMs = parseDuration(first_wake_after);
          if (afterMs === null) return output(durationError(first_wake_after));
          firstWakeAt = clampWakeAt(now, now + afterMs).at;
        }
        const defaultIntervalMs = clampWakeAt(now, now + intervalMs).at - now;

        const id = bots.nextId();
        bots.insert({ id, name });
        try {
          await bot(id).init({
            botId: id,
            name,
            mission,
            defaultIntervalMs,
            firstWakeAt,
          });
        } catch (error) {
          // Do not leave an index row pointing at a bot that never started.
          bots.remove(id);
          throw error;
        }
        return output(`已创建机器人 ${id} ${name}，首次唤醒：${iso(firstWakeAt)}`);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const listBots: ToolRegistration<typeof ListBots> = {
    name: "list_bots",
    description: "List bots with their status and next wake time.",
    parameters: ListBots,
    replay: "safe",
    async execute() {
      try {
        const lines: string[] = [];
        for (const row of bots.list()) {
          const snapshot = await bot(row.id).snapshot();
          if (snapshot === null) continue;
          const next =
            snapshot.meta.nextWakeAt === null
              ? "—"
              : iso(snapshot.meta.nextWakeAt);
          lines.push(
            `${row.id} [${snapshot.meta.status}] ${row.name} 下次：${next}`,
          );
        }
        return output(lines.length === 0 ? "没有机器人" : lines.join("\n"));
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const getBot: ToolRegistration<typeof BotId> = {
    name: "get_bot",
    description:
      "Show one bot's status, mission, recent runs and memories.",
    parameters: BotId,
    replay: "safe",
    async execute({ id }) {
      try {
        const snapshot = await bot(id).snapshot();
        if (snapshot === null) return output(`没有机器人 ${id}`);
        const { meta, runs, memories } = snapshot;

        const lines = [
          `${meta.botId} [${meta.status}] ${meta.name}`,
          `使命：${meta.mission}`,
          "最近运行：",
        ];
        if (runs.length === 0) lines.push("无");
        for (const run of runs) {
          const details = [run.outcome ?? "未结束", iso(run.startedAt)];
          if (run.summary) details.push(run.summary);
          lines.push(`- ${run.taskId} ${details.join(" ")}`);
        }

        lines.push("记忆：");
        if (memories.length === 0) lines.push("无");
        for (const memory of memories.slice(-RENDER_LIMIT)) {
          lines.push(`- #${memory.id} ${memory.content}`);
        }
        return output(lines.join("\n"));
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const steerBot: ToolRegistration<typeof SteerBot> = {
    name: "steer_bot",
    description:
      "Add an instruction for a bot's next run, and to its running task if any.",
    parameters: SteerBot,
    async execute({ id, text }) {
      try {
        if (!bots.get(id)) return output(`没有机器人 ${id}`);
        const { currentTaskId } = await bot(id).steer(text);
        if (currentTaskId !== null) {
          await task(currentTaskId).steer(text);
        }
        return output(`已记录对 ${id} 的指令`);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const wakeBot: ToolRegistration<typeof BotId> = {
    name: "wake_bot",
    description: "Wake a bot now instead of waiting for its next wake time.",
    parameters: BotId,
    async execute({ id }) {
      try {
        if (!bots.get(id)) return output(`没有机器人 ${id}`);
        const result = await bot(id).wakeNow();
        if (result === "after_run") {
          return output(`${id} 正在运行，结束后约 5 分钟再唤醒`);
        }
        if (result === "inactive") {
          return output(`${id} 已暂停或已完成，先恢复再唤醒`);
        }
        return output(`已安排 ${id} 立即唤醒`);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const pauseBot: ToolRegistration<typeof BotId> = {
    name: "pause_bot",
    description: "Pause a bot until it is resumed.",
    parameters: BotId,
    async execute({ id }) {
      try {
        if (!bots.get(id)) return output(`没有机器人 ${id}`);
        await bot(id).pause();
        return output(`已暂停 ${id}`);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const resumeBot: ToolRegistration<typeof ResumeBot> = {
    name: "resume_bot",
    description: "Resume a paused bot, optionally waking it right away.",
    parameters: ResumeBot,
    async execute({ id, wake_now }) {
      try {
        if (!bots.get(id)) return output(`没有机器人 ${id}`);
        await bot(id).resume(wake_now === true);
        const nextWakeAt = (await bot(id).snapshot())?.meta.nextWakeAt;
        const next =
          nextWakeAt === null || nextWakeAt === undefined
            ? "—"
            : iso(nextWakeAt);
        return output(`已恢复 ${id}，下次唤醒：${next}`);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const renameBot: ToolRegistration<typeof RenameBot> = {
    name: "rename_bot",
    description: "Rename a bot. Its id stays the same.",
    parameters: RenameBot,
    async execute({ id, name }) {
      try {
        const row = bots.get(id);
        if (!row) return output(`没有机器人 ${id}`);
        // Whitespace and format characters (zero-width space, BOM) would make
        // the bot invisible in list_bots and in the `🤖 <name>：` prefix.
        if (/^[\s\p{Cf}]*$/u.test(name)) return output("名字不能为空");
        const trimmed = name.trim();
        // The index write is local and fails cheaply; the BotDO write is an
        // RPC, so it comes second and is undone if the DO has no meta.
        if (!bots.rename(id, trimmed)) return output(`没有机器人 ${id}`);
        if (!(await bot(id).rename(trimmed))) {
          // An orphan index row: put the old name back so both stores agree.
          bots.rename(id, row.name);
          return output(`没有机器人 ${id}`);
        }
        return output(`已将 ${id} 改名为 ${trimmed}`);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const deleteBot: ToolRegistration<typeof BotId> = {
    name: "delete_bot",
    description:
      "Delete a bot, cancelling its running task and clearing its data.",
    parameters: BotId,
    async execute({ id }) {
      try {
        if (!bots.get(id)) return output(`没有机器人 ${id}`);
        const currentTaskId = (await bot(id).snapshot())?.meta.currentTaskId;
        if (currentTaskId !== null && currentTaskId !== undefined) {
          await task(currentTaskId).cancel();
        }
        await bot(id).destroy();
        bots.remove(id);
        return output(`已删除机器人 ${id}`);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  return [
    createBot,
    listBots,
    getBot,
    steerBot,
    wakeBot,
    pauseBot,
    resumeBot,
    renameBot,
    deleteBot,
  ];
}
