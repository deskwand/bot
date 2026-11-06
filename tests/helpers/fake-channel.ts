import type { ChannelAdapter } from "../../src/channels/types";
import type { Button, InboundEvent, OutboundMessage } from "../../src/protocol";

export type SentMessage = {
  chatId: string;
  text: string;
  buttons?: Button[][];
};

export type SentArtifact = {
  chatId: string;
  name: string;
  contentType: string;
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
  artifacts: SentArtifact[];
} {
  const sent: SentMessage[] = [];
  const edits: EditedMessage[] = [];
  const artifacts: SentArtifact[] = [];

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
    async sendArtifact(chatId, file) {
      artifacts.push({ chatId, name: file.name, contentType: file.contentType });
    },
    async answerAction() {},
  };

  return { adapter, sent, edits, artifacts };
}
