/**
 * WeChat's iLink protocol only carries plain text, but the WeChat client
 * renders most Markdown in place: bold, code blocks, inline code, tables,
 * H1-H4 and horizontal rules. Only three constructs stay literal, so this
 * module strips exactly those and leaves everything else untouched:
 *
 * - images (`![alt](url)`) are not supported at all,
 * - H5/H6 headings (`#####`/`######`) show their hashes,
 * - single-asterisk italics around CJK text show their asterisks.
 *
 * Code runs are scanned first and copied verbatim, so the filter never
 * rewrites fenced, indented or inline code. Backslash-escaped markers also
 * stay literal. Unfinished Markdown is passed through instead of throwing.
 */

type Line = { body: string; ending: string };
type Fence = { marker: string; length: number };
type Segment = { text: string; code: boolean };
type ItalicMatch = { content: string; end: number };

const CJK_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const H5_H6_MARKER = /^ {0,3}#{5,6}(?:[ \t]+|$)/;
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const INDENTED_CODE_LINE = /^(?: {4}|\t)/;
/** Blockquote markers in front of a line; fences may sit inside a quote. */
const QUOTE_PREFIX = /^ {0,3}(?:> ?)*/;

/** Turn outbound Markdown into the text WeChat can actually display. */
export function toWeChatText(markdown: string): string {
  let fence: Fence | null = null;
  let output = "";

  for (const line of splitLines(markdown)) {
    if (fence) {
      output += line.body + line.ending;
      if (isClosingFence(line.body, fence)) fence = null;
      continue;
    }

    const opening = openingFence(line.body);
    if (opening) {
      fence = opening;
      output += line.body + line.ending;
      continue;
    }

    if (INDENTED_CODE_LINE.test(line.body)) {
      output += line.body + line.ending;
      continue;
    }

    output += transformPlainLine(line.body) + line.ending;
  }

  return output;
}

/** Split while keeping each line's own terminator, so CRLF and bare CR survive. */
function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start;
    while (end < text.length && text[end] !== "\n" && text[end] !== "\r") {
      end++;
    }

    let ending = "";
    if (text[end] === "\r") {
      ending = text[end + 1] === "\n" ? "\r\n" : "\r";
    } else if (text[end] === "\n") {
      ending = "\n";
    }

    lines.push({ body: text.slice(start, end), ending });
    start = end + ending.length;
  }

  return lines;
}

/** Drop leading blockquote markers so quoted fences are recognised too. */
function afterQuote(body: string): string {
  const prefix = QUOTE_PREFIX.exec(body);
  return prefix ? body.slice(prefix[0].length) : body;
}

function openingFence(body: string): Fence | null {
  const match = OPENING_FENCE.exec(afterQuote(body));
  if (!match) return null;

  const run = match[1]!;
  const marker = run[0]!;
  // A backtick fence's info string must not contain backticks.
  if (marker === "`" && match[2]!.includes("`")) return null;

  return { marker, length: run.length };
}

function isClosingFence(body: string, fence: Fence): boolean {
  const match = CLOSING_FENCE.exec(afterQuote(body));
  if (!match) return false;

  const run = match[1]!;
  return run[0] === fence.marker && run.length >= fence.length;
}

function transformPlainLine(line: string): string {
  const withoutHeading = line.replace(H5_H6_MARKER, "");

  let output = "";
  for (const segment of splitCodeSpans(withoutHeading)) {
    output += segment.code ? segment.text : stripUnsupported(segment.text);
  }
  return output;
}

/** Split one line into code spans and the plain text between them. */
function splitCodeSpans(line: string): Segment[] {
  const segments: Segment[] = [];
  let plainStart = 0;
  let index = 0;

  while (index < line.length) {
    if (line[index] !== "`" || isEscaped(line, index)) {
      index++;
      continue;
    }

    const openEnd = runEnd(line, index);
    const closeEnd = findClosingRun(line, openEnd, openEnd - index);
    if (closeEnd === null) {
      // No matching delimiter: the backticks stay literal text.
      index = openEnd;
      continue;
    }

    if (index > plainStart) {
      segments.push({ text: line.slice(plainStart, index), code: false });
    }
    segments.push({ text: line.slice(index, closeEnd), code: true });
    plainStart = closeEnd;
    index = closeEnd;
  }

  if (plainStart < line.length) {
    segments.push({ text: line.slice(plainStart), code: false });
  }

  return segments;
}

/** Index just past the backtick run starting at `start`. */
function runEnd(text: string, start: number): number {
  let end = start;
  while (text[end] === "`") end++;
  return end;
}

/** Index just past a closing run of exactly `length`, or null. */
function findClosingRun(
  text: string,
  from: number,
  length: number,
): number | null {
  let index = from;

  while (index < text.length) {
    if (text[index] !== "`") {
      index++;
      continue;
    }

    const end = runEnd(text, index);
    if (end - index === length && !isEscaped(text, index)) return end;
    index = end;
  }

  return null;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

/** Apply the three removals to text that contains no code spans. */
function stripUnsupported(text: string): string {
  let output = "";
  let index = 0;

  while (index < text.length) {
    const character = text[index]!;

    // Copy escaped pairs intact so escaped markers are never reconsidered.
    if (character === "\\" && index + 1 < text.length) {
      output += text.slice(index, index + 2);
      index += 2;
      continue;
    }

    if (character === "!" && text[index + 1] === "[") {
      const end = imageEnd(text, index);
      if (end !== null) {
        index = end;
        continue;
      }
    }

    if (character === "*") {
      const italic = matchItalic(text, index);
      if (italic !== null) {
        output += italic.content;
        index = italic.end;
        continue;
      }
    }

    output += character;
    index++;
  }

  return output;
}

/**
 * Match a single-asterisk italic span. Chinese content is returned without
 * its markers. A rejected candidate returns null so the caller emits just the
 * opening asterisk: the scan then reconsiders the following asterisks, which
 * keeps English italics and bold runs intact.
 */
function matchItalic(text: string, start: number): ItalicMatch | null {
  // The opener must stand alone: inside a run such as `**` it is bold syntax.
  if (text[start + 1] === "*" || text[start - 1] === "*") return null;

  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] !== "*") {
      cursor++;
      continue;
    }

    if (isEscaped(text, cursor)) {
      cursor++;
      continue;
    }

    // A run of two or more asterisks is bold/delimiter syntax, never a
    // closer. Accepting a later single asterisk as the closer would swallow
    // the bold markers, so abort the whole candidate instead.
    if (text[cursor + 1] === "*" || text[cursor - 1] === "*") return null;

    const content = text.slice(start + 1, cursor);
    if (
      content.length > 0 &&
      CJK_CHARACTER.test(content) &&
      !content.includes("*") &&
      !/^[ \t]|[ \t]$/.test(content)
    ) {
      return { content, end: cursor + 1 };
    }

    return null;
  }

  return null;
}

/** Index just past a complete `![alt](destination "title")`, or null. */
function imageEnd(text: string, start: number): number | null {
  const altEnd = closingBracket(text, start + 1);
  if (altEnd === null || text[altEnd] !== "(") return null;

  return closingParen(text, altEnd);
}

/** Index just past the balanced `]` matching the `[` at `openIndex`. */
function closingBracket(text: string, openIndex: number): number | null {
  if (text[openIndex] !== "[") return null;

  let depth = 0;
  for (let index = openIndex; index < text.length; index++) {
    const character = text[index];

    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "[") {
      depth++;
      continue;
    }
    if (character === "]") {
      depth--;
      if (depth === 0) return index + 1;
    }
  }

  return null;
}

/** Index just past the balanced `)` matching the `(` at `openIndex`. */
function closingParen(text: string, openIndex: number): number | null {
  if (text[openIndex] !== "(") return null;

  let depth = 0;
  for (let index = openIndex; index < text.length; index++) {
    const character = text[index];

    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "(") {
      depth++;
      continue;
    }
    if (character === ")") {
      depth--;
      if (depth === 0) return index + 1;
      continue;
    }

    // A quoted title may contain parentheses; skip it as a unit.
    if (character === '"' || character === "'") {
      const previous = text[index - 1];
      if (previous === " " || previous === "\t") {
        const quoteEnd = closingQuote(text, index);
        if (quoteEnd !== null) index = quoteEnd - 1;
      }
    }
  }

  return null;
}

/** Index just past the quote matching the one at `openIndex`. */
function closingQuote(text: string, openIndex: number): number | null {
  const quote = text[openIndex];

  for (let index = openIndex + 1; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === quote) return index + 1;
  }

  return null;
}
