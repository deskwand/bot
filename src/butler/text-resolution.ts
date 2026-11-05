import type { TextAction } from "../channels/text-action";
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
      return reply(`#${handle} 当前没有进行中的任务`);
    }
    if (action.action === "cancel") {
      return act(row);
    }
    if (action.approvalId !== undefined) {
      return act(row, action.approvalId);
    }
    const candidates = pending.filter((item) => item.taskId === row.id);
    if (candidates.length === 0) return reply(`${taskLabel(row)} 没有待审批`);
    if (candidates.length === 1) return act(row, candidates[0]!.approvalId);
    return reply(listPending(candidates));
  }

  if (action.action === "cancel") {
    if (active.length === 0) return { kind: "chat" };
    if (active.length === 1) return act(active[0]!);
    return reply(listActive(active));
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
  return reply(listPending(pending));
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

function listActive(active: TaskRow[]): string {
  const lines = active.map((row) => `${taskLabel(row)} ${row.title}`);
  return `当前有 ${active.length} 个任务在进行，请写明编号：\n${lines.join("\n")}`;
}

function listPending(pending: PendingApproval[]): string {
  const lines = pending.map(
    (item) =>
      `${taskLabel({ id: item.taskId, handle: item.handle })} ${item.approvalId} ${item.title}`,
  );
  return `当前有 ${pending.length} 个待审批，请写明编号：\n${lines.join("\n")}`;
}
