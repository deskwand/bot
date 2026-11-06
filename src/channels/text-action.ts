import { t, type Locale } from "../i18n";
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
  // Chinese and English command words are protocol aliases, not copy.
  批准: "approve", // i18n-ignore: command alias
  拒绝: "reject", // i18n-ignore: command alias
  取消: "cancel", // i18n-ignore: command alias
  approve: "approve",
  reject: "reject",
  cancel: "cancel",
};

/** Spell one command word both ways while leaving non-letters alone. */
function caseInsensitive(word: string): string {
  return Array.from(word, (char) => {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    return lower === upper ? char : `[${lower}${upper}]`;
  }).join("");
}

const COMMAND_PATTERN = new RegExp(
  `^(${Object.keys(COMMANDS).map(caseInsensitive).join("|")})` +
    `(?:\\s+(?:#?(\\d+)|(t\\d+)))?(?:\\s+(ap\\d+))?$`,
);

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

/** The copyable reply hint shown on channels without buttons. */
export function textHint(locale: Locale, command: string): string {
  return t(locale, "channel.hint", { hint: command });
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
  const match = COMMAND_PATTERN.exec(command);
  if (!match) return null;

  const action = COMMANDS[match[1]!.toLowerCase()];
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
