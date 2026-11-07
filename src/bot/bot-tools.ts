import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  FINISH_BOT_TOOL,
  PROPOSE_RULES_TOOL,
  rejectionText,
  type ApprovalGateLike,
} from "../task/approvals";
import type { RunRow } from "./bot-store";
import { RULES_DOC, checkDocWrite } from "./docs";
import { parseDuration } from "./wake";

/** The Bot DO operations one bot run needs. Structural so tests can fake it. */
export type BotControl = {
  writeDoc(
    name: string,
    content: string,
    options: { allowRules: boolean },
  ): Promise<{ ok: boolean; message: string }>;
  searchRuns(keyword: string): Promise<RunRow[]>;
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
  approvals: ApprovalGateLike;
};

/** Used when the tool context carries no abort signal. */
const NEVER_ABORTED = new AbortController().signal;

const RECORD_TEXT_LIMIT = 500;

const WriteDoc = Type.Object({
  name: Type.String(),
  content: Type.String(),
});

const ProposeRules = Type.Object({
  content: Type.String(),
  reason: Type.String(),
});

const SearchRuns = Type.Object({ keyword: Type.String() });

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

function clampText(text: string): string {
  if (text.length <= RECORD_TEXT_LIMIT) return text;
  return `${text.slice(0, RECORD_TEXT_LIMIT)}…`;
}

/** `search_runs`, shared by bot runs and direct bot chats. */
export function searchRunsTool(
  bot: () => Pick<BotControl, "searchRuns">,
): ToolRegistration {
  const searchRuns: ToolRegistration<typeof SearchRuns> = {
    name: "search_runs",
    description:
      "Search this bot's older runs (notes and summaries) by keyword.",
    parameters: SearchRuns,
    replay: "safe",
    async execute({ keyword }) {
      try {
        const runs = await bot().searchRuns(keyword);
        if (runs.length === 0) return output("没有匹配的运行记录");
        return output(
          runs
            .map((run) => {
              const details = [run.note, run.summary]
                .filter(
                  (value): value is string =>
                    value !== null && value.length > 0,
                )
                .map(clampText);
              return `- ${run.taskId} ${iso(run.startedAt)}（${
                run.outcome ?? "未结束"
              }）：${details.join("；")}`;
            })
            .join("\n"),
        );
      } catch (error) {
        return output(errorText(error));
      }
    },
  };
  return searchRuns;
}

/** `set_next_wake`, shared by bot runs and direct bot chats. */
export function setNextWakeTool(
  bot: () => Pick<BotControl, "setNextWake">,
): ToolRegistration {
  const setNextWake: ToolRegistration<typeof SetNextWake> = {
    name: "set_next_wake",
    description:
      "Schedule the next run, either after a duration such as `2h` or at a UTC ISO time. The latest allowed time is one default interval from now; to sleep longer, wake up and schedule again.",
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
        const result = await bot().setNextWake(req);
        const hint = result.clamped ? "（已调整到允许范围）" : "";
        return output(`下次唤醒：${iso(result.at)}${hint}`);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };
  return setNextWake;
}

/**
 * Tools installed on a TaskDO that runs for a bot. They write through to the
 * bot's own storage. `propose_rules`, `notify_owner` and `finish_bot` are not
 * idempotent and must not replay after a restart.
 */
export function createBotTaskTools(
  deps: BotTaskToolDeps,
): ToolRegistration[] {
  const { bot, taskId, notify, approvals } = deps;

  const writeDoc: ToolRegistration<typeof WriteDoc> = {
    name: "write_doc",
    description:
      "Overwrite one of this bot's documents with its full new text (empty text deletes it). `记忆` holds curated long-term facts and state; any other name is a method document. Changes take effect from the next run. `守则` cannot be written here.",
    parameters: WriteDoc,
    replay: "safe",
    async execute({ name, content }) {
      try {
        const result = await bot.writeDoc(name, content, {
          allowRules: false,
        });
        return output(result.message);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const proposeRules: ToolRegistration<typeof ProposeRules> = {
    name: PROPOSE_RULES_TOOL,
    description:
      "Propose the full new text of this bot's rules (`守则`) with a short reason. The owner must approve; nothing changes if they reject or do not answer.",
    parameters: ProposeRules,
    // The approval gate already refuses to wake a tool after a restart.
    async execute({ content, reason }, _api, context) {
      const trimmed = content.trim();
      // Reject an over-long proposal before asking the owner.
      const check = checkDocWrite([], RULES_DOC, trimmed, {
        allowRules: true,
      });
      if (!check.ok) return output(check.message);

      const signal = context.abortSignal;
      const decision = await approvals.request(
        PROPOSE_RULES_TOOL,
        { content: trimmed, reason },
        signal ?? NEVER_ABORTED,
      );
      if (decision === "approved") {
        try {
          const result = await bot.writeDoc(RULES_DOC, trimmed, {
            allowRules: true,
          });
          return output(result.message);
        } catch (error) {
          return output(errorText(error));
        }
      }

      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      return {
        isError: true,
        output: [
          {
            type: "text",
            text: rejectionText(decision),
          },
        ],
      };
    },
  };

  const searchRuns = searchRunsTool(() => bot);

  const setNextWake = setNextWakeTool(() => bot);

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
    name: FINISH_BOT_TOOL,
    description:
      "Ask the owner to permanently retire this bot. Nothing changes unless they approve. Do NOT call it to end this run (use finish_task) and never for recurring missions.",
    parameters: FinishBot,
    // The approval gate already refuses to wake a tool after a restart.
    async execute({ reason }, _api, context) {
      const signal = context.abortSignal;
      const decision = await approvals.request(
        FINISH_BOT_TOOL,
        { reason },
        signal ?? NEVER_ABORTED,
      );
      if (decision === "approved") {
        try {
          await bot.finish(reason);
          return output("已结束机器人");
        } catch (error) {
          return output(errorText(error));
        }
      }

      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      return {
        isError: true,
        output: [
          {
            type: "text",
            text: rejectionText(decision),
          },
        ],
      };
    },
  };

  return [
    writeDoc,
    proposeRules,
    searchRuns,
    note,
    setNextWake,
    notifyOwner,
    finishBot,
  ];
}
