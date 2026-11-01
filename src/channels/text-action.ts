import type { ActionKind } from "../protocol";

export type TextAction = {
  action: ActionKind;
  taskId: string;
  approvalId?: string;
};

const COMMANDS: Record<string, ActionKind> = {
  批准: "approve",
  拒绝: "reject",
  取消: "cancel",
};

/**
 * Deterministic owner commands for channels without buttons.
 *
 * Approve and reject must name the approval explicitly: the model is never
 * allowed to guess which pending approval the owner means. Cancel names only
 * the task, because `TaskDO.handleAction` resolves it without an approval id.
 */
export function parseTextAction(text: string): TextAction | null {
  const match = /^(批准|拒绝|取消)\s+(\S+)(?:\s+(\S+))?$/.exec(text.trim());
  if (!match) return null;

  const action = COMMANDS[match[1]!];
  const taskId = match[2]!;
  const approvalId = match[3];

  if (action === "cancel") {
    return approvalId === undefined ? { action, taskId } : null;
  }
  return approvalId === undefined ? null : { action, taskId, approvalId };
}
