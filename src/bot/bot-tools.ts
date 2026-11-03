import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { parseDuration } from "./wake";

/** The Bot DO operations one bot run needs. Structural so tests can fake it. */
export type BotControl = {
  remember(content: string): Promise<number>;
  forget(id: number): Promise<boolean>;
  setNextWake(req: {
    afterMs?: number;
    at?: number;
  }): Promise<{ at: number; clamped: boolean }>;
  note(taskId: string, text: string): Promise<void>;
  finish(reason: string): Promise<void>;
};

export type BotTaskToolDeps = {
  bot: BotControl;
  taskId: () => string;
  notify(text: string): Promise<boolean>;
};

const BotRemember = Type.Object({ content: Type.String() });

const BotForget = Type.Object({ id: Type.Number() });

const SetNextWake = Type.Object({
  after: Type.Optional(Type.String()),
  at: Type.Optional(Type.String()),
});

const BotNote = Type.Object({ text: Type.String() });

const NotifyOwner = Type.Object({ text: Type.String() });

const FinishBot = Type.Object({ reason: Type.String() });

function output(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Tools installed on a TaskDO that runs for a bot. They write through to the
 * bot's own storage; `notify_owner` and `finish_bot` have external effects and
 * must not replay after a restart.
 */
export function createBotTaskTools(
  deps: BotTaskToolDeps,
): ToolRegistration[] {
  const { bot, taskId, notify } = deps;

  const remember: ToolRegistration<typeof BotRemember> = {
    name: "bot_remember",
    description: "Save a long-term memory that later runs of this bot will see.",
    parameters: BotRemember,
    replay: "safe",
    async execute({ content }) {
      try {
        const id = await bot.remember(content);
        if (id < 0) return output("机器人不存在");
        return output(`已记住（#${id}）`);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const forget: ToolRegistration<typeof BotForget> = {
    name: "bot_forget",
    description: "Delete one of this bot's memories by its id.",
    parameters: BotForget,
    replay: "safe",
    async execute({ id }) {
      try {
        return output((await bot.forget(id)) ? "已忘记" : "没有这条记忆");
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const setNextWake: ToolRegistration<typeof SetNextWake> = {
    name: "set_next_wake",
    description:
      "Schedule the next run, either after a duration such as `2h` or at a UTC ISO time.",
    parameters: SetNextWake,
    replay: "safe",
    async execute({ after, at }) {
      if ((after === undefined) === (at === undefined)) {
        return output("after 和 at 必须二选一");
      }

      let req: { afterMs?: number; at?: number };
      if (after !== undefined) {
        const afterMs = parseDuration(after);
        if (afterMs === null) {
          return output(`时长格式无效：${after}（示例：30m、2h、1d）`);
        }
        req = { afterMs };
      } else {
        const parsed = Date.parse(at!);
        if (Number.isNaN(parsed)) return output(`时间格式无效：${at}`);
        req = { at: parsed };
      }

      try {
        const result = await bot.setNextWake(req);
        const hint = result.clamped ? "（已调整到允许范围）" : "";
        return output(`下次唤醒：${iso(result.at)}${hint}`);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const note: ToolRegistration<typeof BotNote> = {
    name: "bot_note",
    description: "Leave a note for the next run of this bot.",
    parameters: BotNote,
    replay: "safe",
    async execute({ text }) {
      try {
        await bot.note(taskId(), text);
        return output("已记下");
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const notifyOwner: ToolRegistration<typeof NotifyOwner> = {
    name: "notify_owner",
    description: "Send the owner a message right away.",
    parameters: NotifyOwner,
    // Sends a message; must not replay after a restart.
    async execute({ text }) {
      try {
        return output((await notify(text)) ? "已通知" : "未送达");
      } catch {
        return output("未送达");
      }
    },
  };

  const finishBot: ToolRegistration<typeof FinishBot> = {
    name: "finish_bot",
    description: "Declare the bot's mission complete so it stops waking up.",
    parameters: FinishBot,
    // Changes the bot's lifecycle; must not replay after a restart.
    async execute({ reason }) {
      try {
        await bot.finish(reason);
        return output("已结束机器人");
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  return [remember, forget, setNextWake, note, notifyOwner, finishBot];
}
