import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { encodeAction, type OutboundMessage } from "../protocol";
import type { TasksRepo } from "./tasks-repo";

const SpawnTask = Type.Object({
  title: Type.String(),
  instructions: Type.String(),
});

const ListTasks = Type.Object({
  active: Type.Optional(Type.Boolean()),
});

const TaskId = Type.Object({ id: Type.String() });

const SteerTask = Type.Object({ id: Type.String(), text: Type.String() });

export type ButlerToolDeps = {
  env: Env;
  repo: TasksRepo;
  /** The chat currently talking to the Butler, if any. */
  chatId(): string | null;
  send(chatId: string, msg: OutboundMessage): Promise<{ messageId: string }>;
};

function output(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Butler's control tools. Every tool answers the model with text and
 * never throws: a failure is reported to the model, which can explain it.
 */
export function createButlerTools(deps: ButlerToolDeps): ToolRegistration[] {
  const { env, repo } = deps;

  function task(id: string) {
    return env.TASK.get(env.TASK.idFromName(id));
  }

  const spawnTask: ToolRegistration<typeof SpawnTask> = {
    name: "spawn_task",
    description:
      "Start a background task for work that needs many searches/reads or more than about a minute.",
    parameters: SpawnTask,
    async execute({ title, instructions }) {
      try {
        const id = repo.nextId();
        const chatId = deps.chatId();
        repo.insert({ id, title, chatId });

        await task(id).start({ taskId: id, title, instructions });

        if (chatId !== null) {
          try {
            const sent = await deps.send(chatId, {
              text: `⏳ ${id} ${title}：已开始`,
              buttons: [
                [
                  {
                    label: "取消",
                    data: encodeAction({ action: "cancel", taskId: id }),
                  },
                ],
              ],
            });
            repo.update(id, { progressMessageId: sent.messageId });
          } catch (error) {
            console.error(`butler progress message failed: ${errorText(error)}`);
          }
        }

        return output(`已开始任务 ${id}`);
      } catch (error) {
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
        return output(
          rows.map((row) => `${row.id} [${row.status}] ${row.title}`).join("\n"),
        );
      } catch (error) {
        return output(errorText(error));
      }
    },
  };

  const getTask: ToolRegistration<typeof TaskId> = {
    name: "get_task",
    description: "Show one task's status, summary and artifact links.",
    parameters: TaskId,
    replay: "safe",
    async execute({ id }) {
      try {
        const row = repo.get(id);
        if (!row) return output(`没有任务 ${id}`);

        const lines = [`${row.id} [${row.status}] ${row.title}`];
        if (row.summary) lines.push(`摘要：${row.summary}`);
        if (row.artifacts.length > 0) {
          lines.push("产物：");
          for (const artifact of row.artifacts) {
            lines.push(`- ${artifact.name}: ${artifact.url}`);
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
        if (!repo.get(id)) return output(`没有任务 ${id}`);
        return output((await task(id).retryTask()).message);
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
    cancelTask,
    retryTask,
  ];
}
