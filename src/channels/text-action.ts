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

/** Quote pairs the owner may leave around a copied hint. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
];

/**
 * Drops one matched surrounding quote pair.
 *
 * The WeChat text hint reads 回复"批准 t3 ap1", so a verbatim copy arrives
 * wrapped in quotes. Only a balanced pair at both ends is removed; chatter
 * inside the quotes still has to match the command shape.
 */
function unquote(command: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (
      command.length > open.length + close.length &&
      command.startsWith(open) &&
      command.endsWith(close)
    ) {
      return command.slice(open.length, -close.length).trim();
    }
  }
  return command;
}

/**
 * Deterministic owner commands for channels without buttons.
 *
 * Approve and reject must name the approval explicitly: the model is never
 * allowed to guess which pending approval the owner means. Cancel names only
 * the task, because `TaskDO.handleAction` resolves it without an approval id.
 */
export function parseTextAction(text: string): TextAction | null {
  // Task ids are `t<number>` and approval ids `ap<number>`; anything else is
  // ordinary chat, never an implicit approval target.
  const match = /^(批准|拒绝|取消)\s+(t\d+)(?:\s+(ap\d+))?$/.exec(
    unquote(text.trim()),
  );
  if (!match) return null;

  const action = COMMANDS[match[1]!];
  const taskId = match[2]!;
  const approvalId = match[3];

  if (action === "cancel") {
    return approvalId === undefined ? { action, taskId } : null;
  }
  return approvalId === undefined ? null : { action, taskId, approvalId };
}
