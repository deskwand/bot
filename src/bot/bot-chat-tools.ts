import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { BotControl as ManagementControl } from "../butler/bot-tools";
import { searchRunsTool, setNextWakeTool, type BotControl } from "./bot-tools";
import { RULES_DOC } from "./docs";
import { MAX_WAKE_MS, MIN_WAKE_MS, parseDuration } from "./wake";

/** The Bot DO operations a direct chat turn needs. */
export type BotSelf = Pick<
  ManagementControl,
  | "snapshot"
  | "writeDoc"
  | "wakeNow"
  | "pause"
  | "resume"
  | "setDefaultInterval"
  | "steer"
> &
  Pick<BotControl, "searchRuns" | "setNextWake">;

const RunNow = Type.Object({ instruction: Type.String() });

const WriteDoc = Type.Object({
  name: Type.String(),
  content: Type.String(),
});

const SetInterval = Type.Object({ interval: Type.String() });

const Pause = Type.Object({});

const Resume = Type.Object({
  wake_now: Type.Optional(Type.Boolean()),
});

const DURATION_HINT = "（示例：30m、2h、1d）";

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
 * The tools a bot may use while talking to the owner directly. Like the bot
 * management tools they answer with text and never throw: the model explains
 * failures to the owner. `onRulesWritten` receives the new rules text (empty
 * after a deletion) so the caller can append the code-generated confirmation.
 */
export function createBotChatTools(
  self: () => BotSelf,
  onRulesWritten: (rules: string) => void,
): ToolRegistration[] {
  const runNow: ToolRegistration<typeof RunNow> = {
    name: "run_now",
    description:
      "Start a run of this bot now with an instruction, and tell the owner when it finishes.",
    parameters: RunNow,
    async execute({ instruction }) {
      try {
        await self().steer(instruction, { fromChat: true });
        const result = await self().wakeNow();
        if (result === "after_run") {
          return output("正在运行，结束后约 5 分钟再唤醒");
        }
        if (result === "inactive") {
          return output("已暂停或已完成，先恢复再唤醒");
        }
        return output("已安排立即唤醒");
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const writeDoc: ToolRegistration<typeof WriteDoc> = {
    name: "write_doc",
    description:
      "Overwrite one of this bot's documents with its full new text (empty text deletes it). `记忆` holds curated long-term facts; any other name is a method document. `守则` can be written here because the owner asked directly.",
    parameters: WriteDoc,
    async execute({ name, content }) {
      try {
        const result = await self().writeDoc(name, content, {
          allowRules: true,
        });
        if (result.ok && name.trim() === RULES_DOC) {
          onRulesWritten(content.trim());
        }
        return output(result.message);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const setInterval: ToolRegistration<typeof SetInterval> = {
    name: "set_interval",
    description: "Change how often this bot wakes by default.",
    parameters: SetInterval,
    async execute({ interval }) {
      try {
        const intervalMs = parseDuration(interval);
        if (intervalMs === null) {
          return output(`时长格式无效：${interval}${DURATION_HINT}`);
        }
        if (intervalMs < MIN_WAKE_MS || intervalMs > MAX_WAKE_MS) {
          return output(`时长超出范围：${interval}（最短 5m，最长 30d）`);
        }
        const result = await self().setDefaultInterval(intervalMs);
        if (result === null) return output("机器人不存在");
        const next =
          result.nextWakeAt === null ? "—" : iso(result.nextWakeAt);
        return output(`已将默认间隔改为 ${interval}，下次唤醒：${next}`);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const pause: ToolRegistration<typeof Pause> = {
    name: "pause",
    description: "Pause this bot's automatic wakes until it is resumed.",
    parameters: Pause,
    async execute() {
      try {
        await self().pause();
        return output("已暂停");
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const resume: ToolRegistration<typeof Resume> = {
    name: "resume",
    description: "Resume this bot, optionally waking it right away.",
    parameters: Resume,
    async execute({ wake_now }) {
      try {
        await self().resume(wake_now === true);
        return output("已恢复");
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  return [
    runNow,
    writeDoc,
    searchRunsTool(self),
    setNextWakeTool(self),
    setInterval,
    pause,
    resume,
  ];
}
