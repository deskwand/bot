import { t, type Locale } from "../i18n";
import type { TaskState } from "./task-do";

const STATE_KEYS = {
  queued: "task.state.queued",
  running: "task.state.running",
  completed: "task.state.completed",
  failed: "task.state.failed",
  cancelled: "task.state.cancelled",
} as const;

const DECISION_KEYS = {
  approved: "task.approval.approved",
  rejected: "task.approval.rejected",
} as const;

export function taskStateLabel(locale: Locale, state: TaskState): string {
  return t(locale, STATE_KEYS[state]);
}

export function progressSearchText(locale: Locale, query: string): string {
  return t(locale, "task.progress.search", { query });
}

export function progressArtifactText(locale: Locale, ref: string): string {
  return t(locale, "task.progress.artifact", { ref });
}

export function progressTimeText(locale: Locale): string {
  return t(locale, "task.progress.time");
}

export function progressReadText(locale: Locale, url: string): string {
  return t(locale, "task.progress.read", { url });
}

export function progressSaveText(locale: Locale, filename: string): string {
  return t(locale, "task.progress.save", { filename });
}

export function steerNotStartedText(locale: Locale): string {
  return t(locale, "task.control.steerNotStarted");
}

export function steerBlockedText(
  locale: Locale,
  taskId: string,
  state: TaskState,
): string {
  return t(locale, "task.control.steerBlocked", {
    taskId,
    state: taskStateLabel(locale, state),
  });
}

export function steerOkText(locale: Locale, taskId: string): string {
  return t(locale, "task.control.steerOk", { taskId });
}

export function cancelNotStartedText(locale: Locale): string {
  return t(locale, "task.control.cancelNotStarted");
}

export function cancelBlockedText(
  locale: Locale,
  taskId: string,
  state: TaskState,
): string {
  return t(locale, "task.control.cancelBlocked", {
    taskId,
    state: taskStateLabel(locale, state),
  });
}

export function cancelOkText(locale: Locale, taskId: string): string {
  return t(locale, "task.control.cancelOk", { taskId });
}

export function retryNotStartedText(locale: Locale): string {
  return t(locale, "task.control.retryNotStarted");
}

export function retryBlockedText(
  locale: Locale,
  taskId: string,
  state: TaskState,
): string {
  return t(locale, "task.control.retryBlocked", {
    taskId,
    state: taskStateLabel(locale, state),
  });
}

export function retryNotRetryableText(locale: Locale, taskId: string): string {
  return t(locale, "task.control.retryNotRetryable", { taskId });
}

export function retryOkText(locale: Locale, taskId: string): string {
  return t(locale, "task.control.retryOk", { taskId });
}

export function missingApprovalIdText(locale: Locale): string {
  return t(locale, "task.control.missingApprovalId");
}

export function parkedTaskText(locale: Locale): string {
  return t(locale, "task.notice.parked");
}

export function taskIncompleteText(locale: Locale): string {
  return t(locale, "task.notice.incomplete");
}

export function approvalHandledText(locale: Locale): string {
  return t(locale, "task.approval.handled");
}

export function approvalExpiredText(locale: Locale): string {
  return t(locale, "task.approval.expired");
}

export function approvalDecisionText(
  locale: Locale,
  decision: "approved" | "rejected",
): string {
  return t(locale, DECISION_KEYS[decision]);
}

/** The line reporting a tool the reviewer let through without asking. */
export function autoApprovedText(
  locale: Locale,
  tool: string,
  reason: string,
): string {
  return t(locale, "task.approval.autoApproved", { tool, reason });
}

/** Summary shown on a proposed rules card. */
export function proposedRulesText(
  locale: Locale,
  reason: string,
  rules: string,
): string {
  return t(locale, "task.approval.proposeRules", { reason, rules });
}

export function clearedRulesText(locale: Locale): string {
  return t(locale, "task.approval.clearedRules");
}

/** Summary shown on a request to retire the bot for good. */
export function finishBotText(locale: Locale, reason: string): string {
  return t(locale, "task.approval.finishBot", { reason });
}
