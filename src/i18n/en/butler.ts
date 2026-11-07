import type { Messages } from "../messages";

export const butler: Messages["butler"] = {
  action: {
    approve: "approve",
    reject: "reject",
    cancel: "cancel",
  },
  approval: {
    requested: "{label} requests to run {tool}",
    reason: "{reason}",
    approveButton: "Approve",
    rejectButton: "Reject",
    approved: "Approved",
    rejected: "Rejected",
    expired: "Expired",
  },
  task: {
    started: "{label} {title}: Started",
    startFailed: "{label} {title}: {message}",
    progress: "{label} {title}: {detail}",
    completed: "{label} {title}: {body}",
    done: "Completed",
    failed: "{label} {title}: {reason}",
    cancelled: "{label} {title}: Cancelled",
    retryHint: 'Reply "retry" to continue',
    cancelButton: "Cancel",
    missing: "Task not found",
    stalledModel:
      "{label} {title}: waiting for the model, no progress for {minutes} min",
    stalledTool:
      '{label} {title}: last step "{tool}" has not returned for {minutes} min',
    artifactFailed: "Artifact “{name}” was not delivered ({reason})",
  },
  notice: {
    maintenance: "Under maintenance",
    maintenanceRetry: "Under maintenance, try again later",
    sendFailed: "send failed",
    noChannel: "No channel available",
    error: "Something went wrong, try again later",
    imageUnavailable:
      "Received an image but could not read it, please send it again",
    fileTooLarge: "That file is over 15 MB, so it wasn't received",
    fileUnavailable:
      "A file arrived but its content couldn't be fetched; please send it again",
    voiceUnavailable:
      "Received a voice message but could not transcribe it, please send it again or type it out",
    unsupportedMessage:
      "Only text, images and voice messages are supported right now",
    imageModel:
      "This model does not support images; switch to a vision-capable model on the Models page of the desktop app",
    bot: "[{name}] {text}",
    botTaskPrefix: '"{name}" ',
  },
  botChat: {
    deleted: "This bot has been deleted",
    rulesUpdated: "Rules updated: {rules}",
    rulesTruncated: "… ({count} chars total)",
    rulesDeleted: "Rules deleted",
    empty: 'What would you like to say to "{name}"?',
    ambiguous: "Several bots are named {name}; use @id:\n{lines}",
    unavailable: '"{name}" can\'t reply right now; try again later',
  },
  resolution: {
    noActiveTask: "#{handle} has no active task",
    noPendingApproval: "{label} has no pending approval",
    noPendingApprovalId: "#{handle} has no pending approval {approvalId}",
    activeList: "{count} tasks are running. Reply with the task number:\n{lines}",
    pendingList:
      "{count} approvals are pending. Reply with the task number:\n{lines}",
  },
};
