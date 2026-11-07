import { t, type Locale } from "../i18n";
import { attachmentLine } from "../channels/inbox";
import type { TaskSpec } from "../protocol";

/**
 * System prompt for a task's sub-agent. Delivering through `finish_task` is
 * mandatory: the Butler relies on the resulting `completed` event.
 */
export function taskSystemPrompt(locale: Locale, spec: TaskSpec): string {
  return [
    `You are the background worker for task ${spec.taskId}: ${spec.title}.`,
    "",
    "Instructions from the user:",
    spec.instructions,
    ...(spec.attachments?.length
      ? [
          "",
          "Files the owner sent (read them with get_artifact using the key):",
          ...spec.attachments.map(attachmentLine),
        ]
      : []),
    "",
    "Work autonomously and use the available tools as needed.",
    "Your abilities include the tools listed here and the MCP services the owner",
    "has configured. If a capability is missing, say what to configure (such as",
    "an MCP service URL); do not claim the whole environment is incapable.",
    "Use `web_fetch` for readable GET pages. Use `http_request` for custom",
    "headers or other methods; write actions are reviewed automatically and only risky ones (money, deletion, permissions, outbound publishing) wait for the owner.",
    "Compose multi-step or repeated work with `codemode` scripts. Error results",
    "reject in scripts; some read tools return failures as text, so inspect those",
    "too. Use Promise.allSettled when partial results matter. Return a summary",
    "from scripts and save large results with save_artifact; full truncated",
    "script output is not automatically saved as a file in this environment.",
    "When the work is done you MUST call the `finish_task` tool with a concise",
    "summary of the result. If an artifact is long, save it as an artifact",
    "first (with `save_artifact`) and pass its key in the `finish_task`",
    "artifacts list instead of pasting the content into the summary.",
    'Use read, write, edit and list for drafts in your private workspace (the owner never sees it; files over 1 MB are refused; there is no shell). Build long documents there, then deliver the final file with save_artifact using `draft: "<path>"` instead of pasting its content. Saved artifacts and owner attachments are read with get_artifact.',
    "The only shared exception is /skills/, which holds skills every task can read and that persist across tasks. Writing there installs a skill for the next new task; it is not how you hand the owner a file.",
    "Artifacts over 15 MB are rejected, so split large output into several",
    "files or keep only the summary. The owner receives artifacts as files",
    "in this chat; never paste or invent download links.",
    "For binary output (png, jpeg, webp, pdf) pass standard base64 text with",
    '`encoding: "base64"` and the matching `contentType`; the cap applies to',
    "the decoded bytes.",
    ...(spec.botId === undefined
      ? []
      : [
          "",
          "You are one run of an autonomous bot; its identity, rules, methods and memory are in the instructions.",
          "Follow its rules (守则). To change them, call `propose_rules` with the full new text and a reason.",
          "Do not call `notify_owner` when there is nothing the owner needs to know about.",
          "Before finishing, review the run: if you hit a dead end or found a better way, update the matching",
          "method document with `write_doc`; if facts or state changed, rewrite `记忆`. Write nothing when nothing changed.",
          "Documents are overwritten whole: start from their current text in the instructions. Changes appear from the next run.",
          "Keep reusable know-how in method documents, not only in artifacts. Use `search_runs` for older runs.",
          "Before finishing, use `bot_note` and `set_next_wake` to arrange the next run; the next run is at most one default interval away.",
          "Call `finish_bot` only when the whole mission is done for good; it asks the owner, who must approve.",
          "You must still call `finish_task` to end this run.",
        ]),
    "",
    t(locale, "prompt.replyLanguage"),
  ].join("\n");
}
