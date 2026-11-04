import type { InboundEvent, OutboundMessage } from "../protocol";

export interface ChannelAdapter {
  parseInbound(update: unknown): Promise<InboundEvent | null>;
  send(chatId: string, msg: OutboundMessage): Promise<{ messageId: string }>;
  edit(chatId: string, messageId: string, msg: OutboundMessage): Promise<void>;
  answerAction(actionId: string, text?: string): Promise<void>;
}

export class ChannelError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}
