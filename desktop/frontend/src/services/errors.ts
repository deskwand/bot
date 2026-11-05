// Go errors cross the MyGo bridge as CallError messages in the form
// "CODE: human readable message" (or just "CODE"). The UI always renders the
// fixed code next to one actionable line and never echoes a secret.
import { getT, tryT } from "../i18n";

export interface ClientError {
  code: string;
  message: string;
}

const CODED = /^([A-Z][A-Z0-9_]{2,}):\s*([\s\S]*)$/;

export function fallbackCodeMessage(): string {
  return getT()("errors.fallback");
}

export function toClientError(error: unknown): ClientError {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : getT()("errors.operationFailed");
  const match = CODED.exec(raw.trim());
  if (match) {
    const code = match[1] ?? "UNKNOWN";
    const message = (match[2] ?? "").trim();
    return { code, message: message || describeCode(code) };
  }
  return {
    code: "UNKNOWN",
    message: raw.trim() || getT()("errors.operationFailed"),
  };
}

export interface CodeCopy {
  short: string;
  /** False when no copy exists for this code and the line is the generic fallback. */
  known: boolean;
}

/**
 * One actionable line per stable Go error/reason code. The copy lives in the
 * dictionary (`errors.<CODE>`) so it follows the UI language; tests/e2e/
 * client.spec.ts greps the Go sources and fails when a fixed code is missing.
 */
export function codeCopy(code: string): CodeCopy {
  // Every WECHAT_ILINK_* code shares this line, so a new one always has copy.
  if (code.startsWith("WECHAT_ILINK_")) {
    return { short: getT()("errors.wechatFallback"), known: true };
  }
  const short = tryT(`errors.${code}`);
  return short
    ? { short, known: true }
    : { short: fallbackCodeMessage(), known: false };
}

/** Kept for callers that only need the line: logs, e2e and the backup page. */
export function describeCode(code: string): string {
  return codeCopy(code).short;
}

export function isCode(error: unknown, ...codes: string[]): boolean {
  return codes.includes(toClientError(error).code);
}
