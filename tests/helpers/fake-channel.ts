import type { ChannelAdapter } from "../../src/channels/types";
import type { Button, InboundEvent, OutboundMessage } from "../../src/protocol";

export type SentMessage = {
  chatId: string;
  text: string;
  buttons?: Button[][];
};

export type EditedMessage = {
  chatId: string;
  messageId: string;
  text: string;
  buttons?: Button[][];
};

/** A ChannelAdapter that records what the Butler sends, for assertions. */
export function fakeChannel(): {
  adapter: ChannelAdapter;
  sent: SentMessage[];
  edits: EditedMessage[];
} {
  const sent: SentMessage[] = [];
  const edits: EditedMessage[] = [];

  const adapter: ChannelAdapter = {
    parseInbound: async (): Promise<InboundEvent | null> => null,
    async send(chatId, msg: OutboundMessage) {
      sent.push({
        chatId,
        text: msg.text,
        ...(msg.buttons === undefined ? {} : { buttons: msg.buttons }),
      });
      return { messageId: String(sent.length) };
    },
    async edit(chatId, messageId, msg) {
      edits.push({
        chatId,
        messageId,
        text: msg.text,
        ...(msg.buttons === undefined ? {} : { buttons: msg.buttons }),
      });
    },
    async answerAction() {},
  };

  return { adapter, sent, edits };
}
