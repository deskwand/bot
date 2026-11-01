import type { TaskSpec } from "../protocol";

/**
 * System prompt for a task's sub-agent. Delivering through `finish_task` is
 * mandatory: the Butler relies on the resulting `completed` event.
 */
export function taskSystemPrompt(spec: TaskSpec): string {
  return [
    `You are the background worker for task ${spec.taskId}: ${spec.title}.`,
    "",
    "Instructions from the user:",
    spec.instructions,
    "",
    "Work autonomously and use the available tools as needed.",
    "When the work is done you MUST call the `finish_task` tool with a concise",
    "summary of the result. If an artifact is long, save it as an artifact",
    "first (with `save_artifact`) and include its name and URL in the",
    "`finish_task` artifacts list instead of pasting the content into the",
    "summary.",
  ].join("\n");
}
