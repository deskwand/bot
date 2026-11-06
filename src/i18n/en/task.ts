import type { Messages } from "../messages";

export const task: Messages["task"] = {
  progress: {
    search: "Search: {query}",
    artifact: "Read artifact: {ref}",
    time: "Check the time",
    read: "Read: {url}",
    save: "Save: {filename}",
    download: "Downloading {url}",
  },
  invalidUrl: "[invalid URL]",
  state: {
    queued: "queued",
    running: "running",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  },
  control: {
    steerNotStarted: "The task has not started, cannot add instructions",
    steerBlocked: "Task {taskId} is {state}, cannot add instructions",
    steerOk: "Added instructions to task {taskId}",
    cancelNotStarted: "The task has not started, cannot cancel",
    cancelBlocked: "Task {taskId} is {state}, cannot cancel",
    cancelOk: "Task {taskId} cancelled",
    retryNotStarted: "The task has not started, cannot retry",
    retryBlocked: "Task {taskId} is {state}, cannot retry",
    retryNotRetryable: "The failure of task {taskId} cannot be retried",
    retryOk: "Task {taskId} restarted",
    missingApprovalId: "Missing approval ID",
  },
  notice: {
    parked: "The task kept getting interrupted and is paused",
    incomplete: "The task did not finish",
  },
  approval: {
    proposeRules: "Reason: {reason}\nNew rules:\n{rules}",
    finishBot: "Requests to retire this bot for good\nReason: {reason}",
    clearedRules: "(clear the rules)",
    handled: "This approval was already handled or has expired",
    expired: "This approval has expired",
    approved: "Approved",
    rejected: "Rejected",
    autoApproved: "✔️ Auto-approved {tool}: {reason}",
  },
};
