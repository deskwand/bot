import type { TextAction } from "../channels/text-action";
import type { Locale } from "../i18n";
import {
  resolutionActiveList,
  resolutionNoActiveTask,
  resolutionNoPendingApproval,
  resolutionNoPendingApprovalId,
  resolutionPendingList,
} from "./owner-copy";
import { taskLabel, type TaskRow } from "./tasks-repo";

/** One approval that is still waiting for the owner's decision. */
export type PendingApproval = {
  taskId: string;
  handle: number | null;
  approvalId: string;
  title: string;
};

/**
 * What the channel should do with an owner command. `action` names the task by
 * its internal id; `label` is what the owner saw (`#N`), so replies can quote
 * it instead of the id.
 */
export type Resolution =
  | { kind: "action"; taskId: string; label: string; approvalId?: string }
  | { kind: "reply"; text: string }
  | { kind: "chat" };

/**
 * Resolves an implicit or `#N` command against the current candidates.
 *
 * Deterministic on purpose: zero candidates for an implicit command is chat
 * (the owner may be talking to the butler), and ambiguity lists the candidates
 * rather than guessing. An explicit `ap` is passed through and left for the
 * Task DO to accept or reject.
 */
export function resolveTextAction(
  locale: Locale,
  action: TextAction & {
    target: { kind: "implicit" } | { kind: "handle"; handle: number };
  },
  active: TaskRow[],
  pending: PendingApproval[],
): Resolution {
  if (action.target.kind === "handle") {
    const handle = action.target.handle;
    const row = active.find((candidate) => candidate.handle === handle) ?? null;
    if (row === null) {
      return reply(resolutionNoActiveTask(locale, handle));
    }
    if (action.action === "cancel") {
      return act(row);
    }
    if (action.approvalId !== undefined) {
      // Approval ids are per task and handles are reused, so an explicit ap
      // must still be pending on this task before it is acted on.
      const matches = pending.some(
        (item) =>
          item.taskId === row.id && item.approvalId === action.approvalId,
      );
      return matches
        ? act(row, action.approvalId)
        : reply(
            resolutionNoPendingApprovalId(locale, handle, action.approvalId),
          );
    }
    const candidates = pending.filter((item) => item.taskId === row.id);
    if (candidates.length === 0) {
      return reply(resolutionNoPendingApproval(locale, taskLabel(row)));
    }
    if (candidates.length === 1) return act(row, candidates[0]!.approvalId);
    return reply(resolutionPendingList(locale, candidates));
  }

  if (action.action === "cancel") {
    if (active.length === 0) return { kind: "chat" };
    if (active.length === 1) return act(active[0]!);
    return reply(resolutionActiveList(locale, active));
  }

  if (pending.length === 0) return { kind: "chat" };
  if (pending.length === 1) {
    const only = pending[0]!;
    return {
      kind: "action",
      taskId: only.taskId,
      label: taskLabel({ id: only.taskId, handle: only.handle }),
      approvalId: only.approvalId,
    };
  }
  return reply(resolutionPendingList(locale, pending));
}

function act(
  row: Pick<TaskRow, "id" | "handle">,
  approvalId?: string,
): Resolution {
  const label = taskLabel(row);
  return approvalId === undefined
    ? { kind: "action", taskId: row.id, label }
    : { kind: "action", taskId: row.id, label, approvalId };
}

function reply(text: string): Resolution {
  return { kind: "reply", text };
}
