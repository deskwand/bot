import {
  renderMarkdown,
  splitMessage as splitRendered,
  type MessageEntity,
} from "telegram-md-entities";

/** A chunk ready to POST to the Bot API: plain text plus its formatting. */
export type TelegramChunk = { text: string; entities: MessageEntity[] };

/** Telegram's per-message text limit, in UTF-16 code units. */
const MAX_TEXT_LENGTH = 4096;

/** Injectable so the failure branch below can be tested. */
export type Renderer = (markdown: string) => {
  text: string;
  entities: MessageEntity[];
};

/**
 * Render markdown into Bot API text + entities and split it into
 * Telegram-sized chunks. The only place that knows how markdown becomes
 * Telegram formatting; every other layer keeps treating replies as markdown.
 */
export function renderForTelegram(
  markdown: string,
  render: Renderer = renderMarkdown,
): TelegramChunk[] {
  try {
    const chunks = splitRendered(render(markdown));
    // Valid nonempty input can render to empty, e.g. []() or <b></b>.
    if (markdown.length > 0 && !chunks.some((chunk) => chunk.text.trim())) {
      return plainChunks(markdown);
    }
    return chunks;
  } catch (error) {
    // Formatting must never cost the user the message.
    console.error("telegram markdown render failed:", error);
    return plainChunks(markdown);
  }
}

/** Preserve all input, including empty input and Unicode surrogate pairs. */
function plainChunks(text: string): TelegramChunk[] {
  if (text.length === 0) return [{ text: "", entities: [] }];
  const chunks: TelegramChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_TEXT_LENGTH, text.length);
    const before = text.charCodeAt(end - 1);
    const after = text.charCodeAt(end);
    if (end < text.length && before >= 0xd800 && before <= 0xdbff &&
        after >= 0xdc00 && after <= 0xdfff) end--;
    chunks.push({ text: text.slice(start, end), entities: [] });
    start = end;
  }
  return chunks;
}
