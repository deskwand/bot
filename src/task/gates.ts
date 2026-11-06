import {
  configApprovalMode,
  type AppConfig,
  type ApprovalMode,
} from "../config";
import type { ApprovalGateLike } from "./approvals";
import type { McpGates } from "../tools/mcp";

/** Read the approval mode, falling back to autonomous if the config is unreadable. */
export function taskApprovalMode(read: () => AppConfig): ApprovalMode {
  try {
    return configApprovalMode(read());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`approval mode read failed, using autonomous: ${reason}`);
    return "autonomous";
  }
}

/**
 * Pick the gate for each write path. Reviewed mode keeps the pre-existing
 * wiring; autonomous mode only asks when the owner forced it.
 */
export function taskGates(
  mode: ApprovalMode,
  gates: {
    approval: ApprovalGateLike;
    reviewed: ApprovalGateLike;
    auto: ApprovalGateLike;
  },
): { write: ApprovalGateLike; mcp: McpGates } {
  const { approval, reviewed, auto } = gates;
  if (mode === "reviewed") {
    return {
      write: reviewed,
      mcp: { approval, destructive: approval, review: reviewed },
    };
  }
  return {
    write: auto,
    mcp: { approval, destructive: auto, review: auto },
  };
}
