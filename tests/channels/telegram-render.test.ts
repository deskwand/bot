import { describe, expect, it, vi } from "vitest";
import {
  renderForTelegram,
  type TelegramChunk,
} from "../../src/channels/telegram-render";

const MAX_TEXT_LENGTH = 4096;
const MAX_ENTITIES = 90;
const MAX_ENTITY_URL_LENGTH = 9000;

/** Lone surrogate either half, which Telegram (and UTF-8) cannot carry. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * A chunk must be valid on its own: Telegram sends each chunk as a separate
 * message body, so a surrogate pair cannot be completed by the next chunk.
 */
function expectSelfContained(text: string) {
  expect(LONE_SURROGATE.test(text)).toBe(false);
  expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
}

/** Budgets and entity ranges every chunk must satisfy. */
function expectChunkInvariants(chunk: TelegramChunk) {
  expect(chunk.text.length).toBeGreaterThan(0);
  expect(chunk.text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
  expect(chunk.entities.length).toBeLessThanOrEqual(MAX_ENTITIES);
  expectSelfContained(chunk.text);

  let urlLength = 0;
  for (const entity of chunk.entities) {
    expect(entity.offset).toBeGreaterThanOrEqual(0);
    expect(entity.length).toBeGreaterThan(0);
    expect(entity.offset + entity.length).toBeLessThanOrEqual(
      chunk.text.length,
    );
    urlLength += entity.url?.length ?? 0;
  }
  expect(urlLength).toBeLessThanOrEqual(MAX_ENTITY_URL_LENGTH);
}

const stripWhitespace = (text: string) => text.replace(/\s+/g, "");

describe("renderForTelegram", () => {
  it("turns bold into a bold entity with exact offsets", () => {
    const [chunk] = renderForTelegram("已完成 **任务 A**，请查收");

    expect(chunk.text).toBe("已完成 任务 A，请查收");
    expect(chunk.entities).toEqual([{ type: "bold", offset: 4, length: 4 }]);
  });

  it("bolds chinese text next to fullwidth punctuation", () => {
    const [chunk] = renderForTelegram("重点**“引用”**后继续");

    expect(chunk.text).toBe("重点“引用”后继续");
    expect(chunk.entities).toEqual([{ type: "bold", offset: 2, length: 4 }]);
  });

  it("keeps a fenced code block verbatim, including angle brackets", () => {
    const markdown = '看这段：\n```html\n<div class="x">&nbsp;</div>\n```\n完成。';
    const [chunk] = renderForTelegram(markdown);

    expect(chunk.text).toContain('<div class="x">&nbsp;</div>');
    expect(chunk.entities).toHaveLength(1);
    expect(chunk.entities[0]).toMatchObject({ type: "pre", language: "html" });
  });

  it("sends unfinished markdown as literal text instead of dropping it", () => {
    const [chunk] = renderForTelegram("**还没写完的粗体");

    expect(chunk.text).toBe("**还没写完的粗体");
    expect(chunk.entities).toEqual([]);
  });

  it("splits long chinese text within telegram budgets", () => {
    const markdown = "段落 **粗体** 内容，带链接 [文档](https://example.com/a)。\n\n".repeat(400);
    const chunks = renderForTelegram(markdown);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expectChunkInvariants(chunk);
    }
    expect(chunks.map((c) => c.text).join("")).toContain("段落 粗体 内容");
  });

  it("falls back to plain chunks when the renderer throws", () => {
    const boom = () => {
      throw new Error("renderer exploded");
    };
    const markdown = "x".repeat(5000);

    const chunks = renderForTelegram(markdown, boom);

    expect(chunks.map((c) => c.text.length)).toEqual([4096, 904]);
    expect(chunks.every((c) => c.entities.length === 0)).toBe(true);
    expect(chunks.map((c) => c.text).join("")).toBe(markdown);
  });
});

// Regressions added after the base cases above: empty input, empty renders,
// unfinished constructs, surrogate pairs, split boundaries and budgets.
describe("renderForTelegram input preservation", () => {
  it("returns one empty chunk for empty input, not an empty array", () => {
    expect(renderForTelegram("")).toEqual([{ text: "", entities: [] }]);
  });

  it("returns one empty chunk for empty input even when rendering throws", () => {
    const boom = () => {
      throw new Error("renderer exploded");
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(renderForTelegram("", boom)).toEqual([{ text: "", entities: [] }]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("leaves genuinely blank text for telegram to reject", () => {
    // Whitespace is not silently dropped or turned into something sendable;
    // the Bot API rejection must still reach the caller.
    expect(renderForTelegram("   ")).toEqual([{ text: "   ", entities: [] }]);
  });

  it.each([
    ["empty link", "[]()"],
    ["empty html tag", "<b></b>"],
    ["empty unlabelled fence", "```\n```"],
    ["empty labelled fence", "```js\n```"],
  ])("falls back to the raw markdown when %s renders empty", (_name, markdown) => {
    expect(renderForTelegram(markdown)).toEqual([
      { text: markdown, entities: [] },
    ]);
  });

  it("keeps the whole body of an unfinished code fence in a pre entity", () => {
    const code = '<div class="x">&nbsp;</div>\nconst y = 1;';
    const markdown = `看这段：\n\`\`\`html\n${code}`;
    const [chunk] = renderForTelegram(markdown);

    expect(chunk.text).toContain(code);
    expect(chunk.entities).toHaveLength(1);
    expect(chunk.entities[0]).toMatchObject({ type: "pre", language: "html" });
    expect(chunk.text.slice(
      chunk.entities[0].offset,
      chunk.entities[0].offset + chunk.entities[0].length,
    )).toBe(code);
  });

  it("keeps an unfinished link exactly as written", () => {
    const markdown = "看 [链接](https://example.com/a";

    expect(renderForTelegram(markdown)).toEqual([
      { text: markdown, entities: [] },
    ]);
  });
});

describe("renderForTelegram chunk boundaries", () => {
  const emojiAtBoundary = "x".repeat(4095) + "😀" + "y";

  it("never splits a surrogate pair during normal splitting", () => {
    const chunks = renderForTelegram(emojiAtBoundary);

    expect(chunks.map((c) => c.text.length)).toEqual([4095, 3]);
    for (const chunk of chunks) {
      expectChunkInvariants(chunk);
    }
    expect(chunks.map((c) => c.text).join("")).toBe(emojiAtBoundary);
  });

  it("never splits a surrogate pair in the plain-text fallback", () => {
    const boom = () => {
      throw new Error("renderer exploded");
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const chunks = renderForTelegram(emojiAtBoundary, boom);

      expect(chunks.map((c) => c.text.length)).toEqual([4095, 3]);
      for (const chunk of chunks) {
        expectChunkInvariants(chunk);
      }
      expect(chunks.map((c) => c.text).join("")).toBe(emojiAtBoundary);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("uses utf-16 offsets for entities after an astral character", () => {
    const [chunk] = renderForTelegram("😀 **任务**");

    expect(chunk.text).toBe("😀 任务");
    expect(chunk.entities).toEqual([{ type: "bold", offset: 3, length: 2 }]);
  });

  it("continues a single bold run across chunks", () => {
    const body = "B".repeat(5000);
    const chunks = renderForTelegram(`**${body}**`);

    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expectChunkInvariants(chunk);
      expect(chunk.entities).toHaveLength(1);
      expect(chunk.entities[0]).toMatchObject({
        type: "bold",
        offset: 0,
        length: chunk.text.length,
      });
      expect(chunk.text).toBe(body.slice(0, chunk.text.length));
    }
    expect(chunks.map((c) => c.text).join("")).toBe(body);
  });

  it("continues a single code block across chunks", () => {
    const code = "const x = 1;\n".repeat(400);
    const chunks = renderForTelegram(`\`\`\`js\n${code}\`\`\``);

    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expectChunkInvariants(chunk);
      expect(chunk.entities).toHaveLength(1);
      expect(chunk.entities[0]).toMatchObject({
        type: "pre",
        offset: 0,
        length: chunk.text.length,
        language: "js",
      });
    }
    // The library normalizes whitespace at chunk edges; the non-whitespace
    // body must survive in order.
    expect(stripWhitespace(chunks.map((c) => c.text).join(""))).toBe(
      stripWhitespace(code),
    );
  });

  it("respects the entity count budget", () => {
    const labels = Array.from({ length: 300 }, (_, i) => `b${i}`);
    const markdown = labels.map((label) => `**${label}**`).join(" ");
    const chunks = renderForTelegram(markdown);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((c) => c.entities.length === MAX_ENTITIES)).toBe(true);
    for (const chunk of chunks) {
      expectChunkInvariants(chunk);
    }
    expect(stripWhitespace(chunks.map((c) => c.text).join(""))).toBe(
      stripWhitespace(labels.join(" ")),
    );
  });

  it("respects the entity url budget", () => {
    const url = "https://example.com/" + "a".repeat(3000);
    const labels = Array.from({ length: 6 }, (_, i) => `link${i}`);
    const markdown = labels
      .map((label, i) => `[${label}](${url}/${i})`)
      .join(" ");
    const chunks = renderForTelegram(markdown);

    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expectChunkInvariants(chunk);
      expect(chunk.entities.length).toBeGreaterThan(0);
    }
    expect(stripWhitespace(chunks.map((c) => c.text).join(""))).toBe(
      stripWhitespace(labels.join(" ")),
    );
  });

  it("keeps every numbered section in order across chunks", () => {
    const sections = Array.from(
      { length: 400 },
      (_, i) => `【段${String(i).padStart(3, "0")}】` + "内容".repeat(50),
    );
    const chunks = renderForTelegram(sections.join("\n\n"));

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expectChunkInvariants(chunk);
    }

    const joined = chunks.map((c) => c.text).join("");
    let previous = -1;
    sections.forEach((_section, i) => {
      const marker = `【段${String(i).padStart(3, "0")}】`;
      const position = joined.indexOf(marker);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    });

    // Only whitespace at chunk edges may be normalized away.
    expect(stripWhitespace(joined)).toBe(
      stripWhitespace(sections.join("")),
    );
  });
});
