import { t, type Locale, type MessageKey } from "../i18n";
import type { ActionKind } from "../protocol";
import type { TurnActivity } from "./turn";
import { taskLabel } from "./tasks-repo";

export type ApprovalDecision = "approved" | "rejected" | "expired";

/** A task or approval target named in a copyable command. */
export type ActionHintTarget = { taskId: string; approvalId?: string };

const ACTION_KEYS = {
  approve: "butler.action.approve",
  reject: "butler.action.reject",
  cancel: "butler.action.cancel",
} as const satisfies Record<ActionKind, MessageKey>;

const DECISION_KEYS = {
  approved: "butler.approval.approved",
  rejected: "butler.approval.rejected",
  expired: "butler.approval.expired",
} as const satisfies Record<ApprovalDecision, MessageKey>;

/**
 * The bare command word for an action. Shared with the channel layer, which
 * turns button hints into copyable commands.
 */
export function actionLabel(locale: Locale, action: ActionKind): string {
  return t(locale, ACTION_KEYS[action]);
}

/**
 * A copyable command naming an optional task and approval, such as
 * `批准 t1 ap2` / `approve t1 ap2`. Shared with the channel layer.
 */
export function actionHint(
  locale: Locale,
  action: ActionKind,
  target?: ActionHintTarget,
): string {
  const parts = [actionLabel(locale, action)];
  if (target !== undefined) {
    parts.push(target.taskId);
    if (target.approvalId !== undefined) parts.push(target.approvalId);
  }
  return parts.join(" ");
}

export function approvalButtonLabel(
  locale: Locale,
  action: "approve" | "reject",
): string {
  return t(
    locale,
    action === "approve"
      ? "butler.approval.approveButton"
      : "butler.approval.rejectButton",
  );
}

export function approvalCardText(
  locale: Locale,
  input: {
    prefix?: string;
    label: string;
    tool: string;
    reason?: string;
    argsSummary: string;
  },
): string {
  const head = t(locale, "butler.approval.requested", {
    label: input.label,
    tool: input.tool,
  });
  const reason = input.reason
    ? `\n${t(locale, "butler.approval.reason", { reason: input.reason })}`
    : "";
  return `${input.prefix ?? ""}${head}${reason}\n${input.argsSummary}`;
}

/** The status line appended to a resolved approval card. */
export function decisionSuffix(
  locale: Locale,
  decision: ApprovalDecision,
): string {
  return `\n→ ${t(locale, DECISION_KEYS[decision])}`;
}

/** The one-line receipt for a turn that has not answered yet. */
export function turnAckText(locale: Locale): string {
  return t(locale, "butler.turn.ack");
}

export function turnInterruptedText(locale: Locale): string {
  return t(locale, "butler.turn.interrupted");
}

export function turnEmptyAnswerText(locale: Locale): string {
  return t(locale, "butler.turn.emptyAnswer");
}

/** Where the Butler's own turn stopped, with the same facts as a task stall. */
export function turnStalledText(
  locale: Locale,
  activity: TurnActivity,
  idleMs: number,
): string {
  const minutes = Math.max(1, Math.floor(idleMs / 60_000));
  return activity.kind === "running_tool"
    ? t(locale, "butler.turn.stalledTool", { tool: activity.tool, minutes })
    : t(locale, "butler.turn.stalledModel", { minutes });
}

/** 一个产物没送到时补发的告知；reason 只放稳定短语，不放原始错误。 */
export function artifactFailedText(
  locale: Locale,
  name: string,
  reason: string,
): string {
  return t(locale, "butler.task.artifactFailed", { name, reason });
}

export function taskMissingText(locale: Locale): string {
  return t(locale, "butler.task.missing");
}

export function maintenanceText(locale: Locale): string {
  return t(locale, "butler.notice.maintenance");
}

export function maintenanceRetryText(locale: Locale): string {
  return t(locale, "butler.notice.maintenanceRetry");
}

export function noChannelText(locale: Locale): string {
  return t(locale, "butler.notice.noChannel");
}

export function errorNotice(locale: Locale): string {
  return t(locale, "butler.notice.error");
}

export function imageUnavailableNotice(locale: Locale): string {
  return t(locale, "butler.notice.imageUnavailable");
}

export function fileTooLargeNotice(locale: Locale): string {
  return t(locale, "butler.notice.fileTooLarge");
}

export function fileUnavailableNotice(locale: Locale): string {
  return t(locale, "butler.notice.fileUnavailable");
}

export function voiceUnavailableNotice(locale: Locale): string {
  return t(locale, "butler.notice.voiceUnavailable");
}

export function unsupportedMessageNotice(locale: Locale): string {
  return t(locale, "butler.notice.unsupportedMessage");
}

export function imageModelNotice(locale: Locale): string {
  return t(locale, "butler.notice.imageModel");
}

export function resolutionNoActiveTask(
  locale: Locale,
  handle: number,
): string {
  return t(locale, "butler.resolution.noActiveTask", { handle });
}

export function resolutionNoPendingApproval(
  locale: Locale,
  label: string,
): string {
  return t(locale, "butler.resolution.noPendingApproval", { label });
}

export function resolutionNoPendingApprovalId(
  locale: Locale,
  handle: number,
  approvalId: string,
): string {
  return t(locale, "butler.resolution.noPendingApprovalId", {
    handle,
    approvalId,
  });
}

export function resolutionActiveList(
  locale: Locale,
  rows: readonly { id: string; handle: number | null; title: string }[],
): string {
  const lines = rows.map((row) => `${taskLabel(row)} ${row.title}`);
  return t(locale, "butler.resolution.activeList", {
    count: rows.length,
    lines: lines.join("\n"),
  });
}

export function resolutionPendingList(
  locale: Locale,
  pending: readonly {
    taskId: string;
    handle: number | null;
    approvalId: string;
    title: string;
  }[],
): string {
  const lines = pending.map(
    (item) =>
      `${taskLabel({ id: item.taskId, handle: item.handle })} ${item.approvalId} ${item.title}`,
  );
  return t(locale, "butler.resolution.pendingList", {
    count: pending.length,
    lines: lines.join("\n"),
  });
}
