import type { ModelRef } from "./llm/models";

export type ChannelId = "telegram" | "wechat";

export type Address = { channel: ChannelId; conversationId: string };

export type MessageEvent = {
  type: "message";
  channel: ChannelId;
  chatId: string;
  userId: string;
  text: string | null;
  eventId: string;
};

/** An inbound message that passed the active-channel admission check. */
export type AdmittedMessage = MessageEvent & { routeKey: string };

/** Where a sent message lives, scoped to the deployment that sent it. */
export type ChannelMessageRef = Address & {
  routeKey: string;
  messageId: string | null;
};

/** The channel currently selected, with the ownership key of this instance. */
export type RouteSnapshot = {
  channel: ChannelId | null;
  routeKey: string;
};

export type ActionKind = "approve" | "reject" | "cancel";

export type ActionEvent = {
  type: "action";
  channel: ChannelId;
  chatId: string;
  userId: string;
  actionId: string;
  messageId: string;
  action: ActionKind;
  taskId: string;
  approvalId?: string;
  eventId: string;
};

export type InboundEvent = MessageEvent | ActionEvent;

export type Button = { label: string; data: string };
export type OutboundMessage = { text: string; buttons?: Button[][] };

export type Artifact = { name: string; url: string };

export type TaskEventBody =
  | { type: "started" }
  | { type: "progress"; text: string }
  | { type: "approval_requested"; approvalId: string; tool: string; argsSummary: string }
  | {
      type: "approval_resolved";
      approvalId: string;
      decision: "approved" | "rejected" | "expired";
    }
  | { type: "completed"; summary: string; artifacts: Artifact[] }
  | { type: "failed"; reason: string; retryable: boolean }
  | { type: "cancelled" };

export type TaskEvent = TaskEventBody & { taskId: string; seq: number };

export type TaskSpec = {
  taskId: string;
  title: string;
  instructions: string;
  model?: ModelRef;
};

const ACTION_KINDS: readonly ActionKind[] = ["approve", "reject", "cancel"];

/** Telegram rejects callback_data longer than 64 bytes. */
const MAX_CALLBACK_DATA_BYTES = 64;

export function encodeAction(a: {
  action: ActionKind;
  taskId: string;
  approvalId?: string;
}): string {
  const data =
    a.approvalId === undefined
      ? `a:${a.action}:${a.taskId}`
      : `a:${a.action}:${a.taskId}:${a.approvalId}`;
  if (new TextEncoder().encode(data).length > MAX_CALLBACK_DATA_BYTES) {
    throw new Error(
      `callback_data exceeds ${MAX_CALLBACK_DATA_BYTES} bytes: ${data}`,
    );
  }
  return data;
}

export function decodeAction(
  data: string,
): { action: ActionKind; taskId: string; approvalId?: string } | null {
  const parts = data.split(":");
  if (parts.length !== 3 && parts.length !== 4) return null;
  if (parts[0] !== "a") return null;

  const action = parts[1] as ActionKind;
  if (!ACTION_KINDS.includes(action)) return null;

  const taskId = parts[2];
  if (!taskId) return null;

  if (parts.length === 3) return { action, taskId };

  const approvalId = parts[3];
  if (!approvalId) return null;
  return { action, taskId, approvalId };
}
