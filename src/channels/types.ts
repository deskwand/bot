import type { InboundEvent, OutboundMessage } from "../protocol";

export type OutboundArtifact = {
  name: string;
  contentType: string;
  bytes: ArrayBuffer;
};

export interface ChannelAdapter {
  parseInbound(update: unknown): Promise<InboundEvent | null>;
  send(chatId: string, msg: OutboundMessage): Promise<{ messageId: string }>;
  /** 发送一个产物文件；失败抛出 `ChannelError`（4xx 不重试）。 */
  sendArtifact(chatId: string, file: OutboundArtifact): Promise<void>;
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
