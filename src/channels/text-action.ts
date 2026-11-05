import type { ActionKind } from "../protocol";

export type TextTarget =
  | { kind: "implicit" }
  | { kind: "handle"; handle: number }
  | { kind: "taskId"; taskId: string };

export type TextAction = {
  action: ActionKind;
  target: TextTarget;
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
 * The WeChat text hint reads 回复"批准 #1 ap1", so a verbatim copy arrives
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
 * The owner may name the task by display handle (`#1`, or just `1`), by the
 * legacy internal id (`t61`), or not at all. An implicit approval or rejection
 * is left for the Butler to resolve against the pending candidates: the model
 * is never allowed to guess which approval the owner means.
 */
export function parseTextAction(text: string): TextAction | null {
  // The owner's IME emits the full-width hash; both spellings mean #N.
  const command = unquote(text.trim()).replace(/＃/g, "#");
  const match = /^(批准|拒绝|取消)(?:\s+(?:#?(\d+)|(t\d+)))?(?:\s+(ap\d+))?$/.exec(
    command,
  );
  if (!match) return null;

  const action = COMMANDS[match[1]!];
  const handle = match[2];
  const taskId = match[3];
  const approvalId = match[4];

  const target: TextTarget | null =
    handle !== undefined
      ? { kind: "handle", handle: Number(handle) }
      : taskId !== undefined
        ? { kind: "taskId", taskId }
        : null;

  if (approvalId !== undefined && target === null) return null;
  if (action === "cancel") {
    return approvalId === undefined
      ? { action, target: target ?? { kind: "implicit" } }
      : null;
  }
  if (target === null) return { action, target: { kind: "implicit" } };
  if (target.kind === "handle") {
    return approvalId === undefined
      ? { action, target }
      : { action, target, approvalId };
  }
  return approvalId === undefined
    ? null
    : { action, target, approvalId };
}
