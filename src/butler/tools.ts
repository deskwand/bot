import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { t, type Locale } from "../i18n";
import type { InboundFile, TaskSpec } from "../protocol";
import { parseDuration } from "../bot/wake";
import type { MemoryStore } from "./memory";
import { getClock } from "./notifier";
import type { ScheduleRow } from "./schedules";
import { taskLabel, type TaskRow, type TasksRepo } from "./tasks-repo";

const SpawnTask = Type.Object({
  title: Type.String(),
  instructions: Type.String(),
  attachments: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "inbox keys from [附件] lines the task needs to read",
    }),
  ),
});

const ListTasks = Type.Object({
  active: Type.Optional(Type.Boolean()),
});

const TaskId = Type.Object({ id: Type.String() });

const SteerTask = Type.Object({ id: Type.String(), text: Type.String() });

const QuickLookup = Type.Object({
  question: Type.String(),
  queries: Type.Array(Type.String(), {
    description: "1-3 web search queries",
  }),
});

const Remember = Type.Object({ content: Type.String() });

const Recall = Type.Object({ keyword: Type.String() });

const Forget = Type.Object({ id: Type.Number() });

const CreateSchedule = Type.Object({
  cron: Type.Optional(
    Type.String({ description: "5-field cron expression, interpreted in UTC" }),
  ),
  after: Type.Optional(
    Type.String({ description: "run once after a duration such as 90m, 2h, 1d12h" }),
  ),
  at: Type.Optional(
    Type.String({ description: "run once at this UTC ISO time" }),
  ),
  title: Type.String(),
  instructions: Type.String(),
});

const ScheduleId = Type.Object({ id: Type.String() });

const ListSchedules = Type.Object({});

/** The Task DO operations the control tools call. */
export type TaskControl = {
  start(spec: TaskSpec): Promise<void>;
  status(): Promise<{ state: string; title: string }>;
  steer(text: string): Promise<{ ok: boolean; message: string }>;
  cancel(): Promise<{ ok: boolean; message: string }>;
  retryTask(): Promise<{ ok: boolean; message: string }>;
  continueTask(text: string): Promise<{ ok: boolean; message: string }>;
  liveness(): Promise<{ state: string; reattached: boolean }>;
  pendingApprovals(): Promise<
    {
      approvalId: string;
      tool: string;
      argsSummary: string;
      reason?: string;
    }[]
  >;
};

export type ButlerToolDeps = {
  repo: TasksRepo;
  task(id: string): TaskControl;
  /** Inserts a task row and starts its Task DO; returns the task id. */
  spawn(
    title: string,
    instructions: string,
    attachments?: InboundFile[],
  ): Promise<string>;
  /** Resolves an inbox key to its stored file reference, or null. */
  resolveAttachment(key: string): Promise<InboundFile | null>;
  memory: MemoryStore;
  /** Persists the schedule and registers its Agent callback. */
  createSchedule(
    spec: ScheduleSpec,
    title: string,
    instructions: string,
  ): Promise<string>;
  listSchedules(): ScheduleRow[];
  removeSchedule(id: string): Promise<boolean>;
  /** Answers a small factual question from one or two web searches. */
  lookup(
    question: string,
    queries: string[],
  ): Promise<{ ok: true; answer: string } | { ok: false }>;
  /** Locale for model-facing tool text; defaults to Chinese. */
  locale?: Locale;
};

/** A schedule either repeats on `cron` or fires once at `at`. */
export type ScheduleSpec = { cron: string } | { at: number };

/** A `spawn` that created the task row but could not start its Task DO. */
export class SpawnFailedError extends Error {
  constructor(
    readonly taskId: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "SpawnFailedError";
  }
}

function output(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

function errorOutput(text: string) {
  return { output: [{ type: "text" as const, text }], isError: true };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A task line for the model: an active task with a handle shows both the
 * display handle and the internal id; every other row keeps the legacy shape.
 */
function taskLine(row: TaskRow): string {
  const active = row.status === "queued" || row.status === "running";
  if (active && row.handle !== null) {
    return `#${row.handle}（id ${row.id}）[${row.status}] ${row.title}`;
  }
  return `${row.id} [${row.status}] ${row.title}`;
}

/**
 * The Butler's control tools. Every tool answers the model with text and
 * never throws: a failure is reported to the model, which can explain it.
 */
export function createButlerTools(deps: ButlerToolDeps): ToolRegistration[] {
  const { repo, task, memory } = deps;

  const spawnTask: ToolRegistration<typeof SpawnTask> = {
    name: "spawn_task",
    description:
      "Hand work to a background worker that has many more tools than you (web pages, HTTP, files, scripts, connected services, and more over time). Use it for anything your own tools cannot do, and for work that needs many searches/reads or more than about a minute. Never tell the owner something is impossible without trying this first.",
    parameters: SpawnTask,
    async execute({ title, instructions, attachments }) {
      try {
        const files: InboundFile[] = [];
        for (const key of new Set(attachments ?? [])) {
          const file = await deps.resolveAttachment(key);
          if (file === null) return output(`附件不存在：${key}`);
          files.push(file);
        }
        const id = await deps.spawn(title, instructions, files);
        const row = repo.get(id);
        return output(
          row === null || row.handle === null
            ? `已开始任务 ${id}`
            : `已开始任务 ${taskLabel(row)}（id ${id}）`,
        );
      } catch (error) {
        if (error instanceof SpawnFailedError) {
          return output(`任务 ${error.taskId} 启动失败：${error.reason}`);
        }
        return output(errorText(error));
      }
    },
  };

  const listTasks: ToolRegistration<typeof ListTasks> = {
    name: "list_tasks",
    description: "List tracked tasks, optionally only the active ones.",
    parameters: ListTasks,
    replay: "safe",
    async execute({ active }) {
      try {
        const rows = repo.list(active ? { active: true } : undefined);
        if (rows.length === 0) return output("没有任务");
        return output(rows.map(taskLine).join("\n"));
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const getTask: ToolRegistration<typeof TaskId> = {
    name: "get_task",
    description: "Show one task's status, summary and artifact names.",
    parameters: TaskId,
    replay: "safe",
    async execute({ id }) {
      try {
        if (!repo.get(id)) return output(`没有任务 ${id}`);
        // status() flushes the task's outbox, so asking about a task also
        // repairs a stranded final event.
        await task(id).status();

        const row = repo.get(id);
        if (!row) return output(`没有任务 ${id}`);

        const lines = [taskLine(row)];
        if (row.status === "running" && row.lastProgress !== null) {
          const minutes =
            row.lastProgressAt === null
              ? 0
              : Math.floor((getClock().now() - row.lastProgressAt) / 60_000);
          lines.push(
            t(deps.locale ?? "zh", "butler.task.progressLine", {
              detail: row.lastProgress,
              minutes,
            }),
          );
        }
        if (row.summary) lines.push(`摘要：${row.summary}`);
        if (row.artifacts.length > 0) {
          lines.push("产物：");
          for (const artifact of row.artifacts) {
            lines.push(`- ${artifact.name}`);
          }
        }
        return output(lines.join("\n"));
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const steerTask: ToolRegistration<typeof SteerTask> = {
    name: "steer_task",
    description: "Add an instruction to a running task.",
    parameters: SteerTask,
    async execute({ id, text }) {
      try {
        if (!repo.get(id)) return output(`没有任务 ${id}`);
        return output((await task(id).steer(text)).message);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const quickLookupTool: ToolRegistration<typeof QuickLookup> = {
    name: "quick_lookup",
    description:
      "Look up a fact that one or two web searches can answer (weather, a price, a score, the latest on something) and get a short answer back. Use spawn_task for anything multi-step.",
    parameters: QuickLookup,
    async execute({ question, queries }) {
      try {
        const result = await deps.lookup(question, queries);
        return result.ok
          ? output(result.answer)
          : errorOutput(t(deps.locale ?? "zh", "butler.quickLookup.noResult"));
      } catch (error) {
        return errorOutput(errorText(error));
      }
    },
  };

  const cancelTask: ToolRegistration<typeof TaskId> = {
    name: "cancel_task",
    description: "Cancel a queued or running task.",
    parameters: TaskId,
    async execute({ id }) {
      try {
        if (!repo.get(id)) return output(`没有任务 ${id}`);
        return output((await task(id).cancel()).message);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const retryTask: ToolRegistration<typeof TaskId> = {
    name: "retry_task",
    description: "Retry a failed task.",
    parameters: TaskId,
    async execute({ id }) {
      try {
        const row = repo.get(id);
        if (!row) return output(`没有任务 ${id}`);
        if (row.botId !== null) {
          return output(
            `任务 ${id} 属于机器人 ${row.botId}，请用 wake_bot 让它重新运行`,
          );
        }
        return output((await task(id).retryTask()).message);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const continueTask: ToolRegistration<typeof SteerTask> = {
    name: "continue_task",
    description:
      "Give a completed task a follow-up. It runs in the task's own context (everything it read and decided), so prefer this over a new spawn_task for more work on the same thing.",
    parameters: SteerTask,
    async execute({ id, text }) {
      try {
        const row = repo.get(id);
        if (!row) return output(`没有任务 ${id}`);
        if (row.botId !== null) {
          return output(
            `任务 ${id} 属于机器人 ${row.botId}，请用 steer_bot 给它加指令`,
          );
        }
        return output((await task(id).continueTask(text)).message);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const remember: ToolRegistration<typeof Remember> = {
    name: "remember",
    description:
      "Store a lasting fact about the owner (preferences, routines, people, ongoing plans).",
    parameters: Remember,
    async execute({ content }) {
      try {
        return output(`已记住 #${memory.add(content)}`);
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const recall: ToolRegistration<typeof Recall> = {
    name: "recall",
    description: "Search the stored facts about the owner by keyword.",
    parameters: Recall,
    replay: "safe",
    async execute({ keyword }) {
      try {
        const items = memory.search(keyword);
        if (items.length === 0) return output("没有相关记忆");
        return output(
          items.map((item) => `#${item.id} ${item.content}`).join("\n"),
        );
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const forget: ToolRegistration<typeof Forget> = {
    name: "forget",
    description: "Delete a stored fact by its #id.",
    parameters: Forget,
    async execute({ id }) {
      try {
        return output(
          memory.remove(id) ? `已删除 #${id}` : `没有记忆 #${id}`,
        );
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const createSchedule: ToolRegistration<typeof CreateSchedule> = {
    name: "schedule",
    description: [
      "Create a scheduled background task. Exactly one of `cron`, `after` and `at` is required.",
      "cron repeats: a standard 5-field expression (minute hour day month weekday)",
      "interpreted in UTC. The owner is normally in Asia/Shanghai (UTC+8), so",
      "convert their local time: a daily 09:00 request becomes `0 1 * * *`.",
      "after (a duration such as `90m`, `2h`, `1d`; a week is `7d` and a minute is",
      "the finest step) or at (a UTC ISO time carrying `Z` or an offset) runs",
      "once, then the schedule disappears; call `now` first when the owner names",
      "a clock time.",
    ].join(" "),
    parameters: CreateSchedule,
    async execute({ cron, after, at, title, instructions }) {
      const given = [cron, after, at].filter((value) => value !== undefined);
      if (given.length !== 1) return output("cron、after、at 三选一");

      let spec: ScheduleSpec;
      if (cron !== undefined) {
        spec = { cron };
      } else {
        const now = getClock().now();
        let parsed: number;
        if (after !== undefined) {
          const afterMs = parseDuration(after);
          if (afterMs === null) {
            return output(`时长格式无效：${after}（示例：30m、2h、1d）`);
          }
          parsed = now + afterMs;
        } else {
          parsed = Date.parse(at ?? "");
          if (Number.isNaN(parsed)) return output(`时间格式无效：${at}`);
          // A value without an offset parses as local time, which silently
          // moves a Beijing 10:00 reminder to 18:00, so refuse it.
          if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(at ?? "")) {
            return output(
              `时间必须带时区偏移：${at}（例如 2030-03-01T10:00:00+08:00 或 2030-03-01T02:00:00Z）`,
            );
          }
        }
        if (parsed <= now) {
          return output(
            `时间已过去：${new Date(parsed).toISOString()}，现在是 ${new Date(
              now,
            ).toISOString()}`,
          );
        }
        spec = { at: parsed };
      }

      try {
        const id = await deps.createSchedule(spec, title, instructions);
        if (!("at" in spec)) return output(`已创建定时任务 ${id}`);
        // Echo the instant the owner will actually feel, in both zones.
        const beijing = new Date(spec.at + 8 * 3_600_000)
          .toISOString()
          .slice(0, 16)
          .replace("T", " ");
        return output(
          `已创建定时任务 ${id}（${new Date(spec.at).toISOString()}，北京时间 ${beijing}）`,
        );
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const listSchedules: ToolRegistration<typeof ListSchedules> = {
    name: "list_schedules",
    description:
      "List scheduled tasks with their ids and when they run: a cron expression, or an ISO time for a one-shot.",
    parameters: ListSchedules,
    replay: "safe",
    async execute() {
      try {
        const rows = deps.listSchedules();
        if (rows.length === 0) return output("没有定时任务");
        return output(
          rows
            .map(
              (row) =>
                `${row.id} ${row.at === null ? row.cron : new Date(row.at).toISOString()} ${row.title}`,
            )
            .join("\n"),
        );
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const unschedule: ToolRegistration<typeof ScheduleId> = {
    name: "unschedule",
    description: "Delete a scheduled task by its s<number> id.",
    parameters: ScheduleId,
    async execute({ id }) {
      try {
        return output(
          (await deps.removeSchedule(id))
            ? `已删除定时任务 ${id}`
            : `没有定时任务 ${id}`,
        );
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  return [
    spawnTask,
    listTasks,
    getTask,
    steerTask,
    quickLookupTool,
    cancelTask,
    retryTask,
    continueTask,
    remember,
    recall,
    forget,
    createSchedule,
    listSchedules,
    unschedule,
  ];
}
