const CRLF = "\r\n";
const LATIN1 = new TextDecoder("latin1");
const CRLF_BYTES = [0x0d, 0x0a];
const CRLF_CRLF = [0x0d, 0x0a, 0x0d, 0x0a];
const UTF8 = new TextEncoder();

export type ParsedPart = {
  filename: string;
  size: number;
  contentType: string;
  bytes: Uint8Array;
};

export type ParsedMail = {
  headers: Record<string, string>;
  text: string;
  parts: ParsedPart[];
};

function indexOfSequence(
  bytes: Uint8Array,
  needle: ArrayLike<number>,
  from: number,
): number {
  outer: for (let i = from; i + needle.length <= bytes.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Split a multipart body on `--boundary` at line starts. Works on bytes: a
 * latin1 decode + re-encode would turn every byte above 0x7f into two bytes
 * and silently corrupt 8bit or binary parts.
 */
function splitParts(body: Uint8Array, boundary: string): Uint8Array[] {
  const delimiter = UTF8.encode(`--${boundary}`);
  const parts: Uint8Array[] = [];
  let partStart = -1;
  let cursor = 0;

  for (;;) {
    const at = indexOfSequence(body, delimiter, cursor);
    if (at < 0) break;
    const atLineStart =
      at === 0 || (body[at - 2] === 0x0d && body[at - 1] === 0x0a);
    if (!atLineStart) {
      cursor = at + 1;
      continue;
    }
    if (partStart >= 0) {
      parts.push(body.subarray(partStart, Math.max(partStart, at - 2)));
    }
    const after = at + delimiter.length;
    const closing = body[after] === 0x2d && body[after + 1] === 0x2d;
    if (closing) {
      partStart = -1;
      break;
    }
    const eol = indexOfSequence(body, CRLF_BYTES, after);
    if (eol < 0) {
      partStart = -1;
      break;
    }
    partStart = eol + 2;
    cursor = partStart;
  }

  if (partStart >= 0 && partStart < body.length) {
    parts.push(body.subarray(partStart));
  }
  return parts;
}

function splitHeaderBody(raw: Uint8Array): { head: string; body: Uint8Array } {
  let at = indexOfSequence(raw, CRLF_CRLF, 0);
  let skip = 4;
  if (at < 0) {
    // Tolerate a lone LF separator from older servers.
    at = indexOfSequence(raw, [0x0a, 0x0a], 0);
    skip = 2;
  }
  if (at < 0) return { head: LATIN1.decode(raw), body: new Uint8Array(0) };
  return {
    head: LATIN1.decode(raw.subarray(0, at)),
    body: raw.subarray(at + skip),
  };
}

/** Unfolds and lowercases header names; keeps raw (still encoded) values. */
function splitHeaders(head: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let lastKey: string | null = null;
  for (const line of head.split(CRLF)) {
    if (/^[ \t]/.test(line) && lastKey !== null) {
      headers[lastKey] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (headers[key] !== undefined) continue;
    headers[key] = line.slice(colon + 1).trim();
    lastKey = key;
  }
  return headers;
}

/** Header block only: the same splitter `parseMail` uses, for FETCH header replies. */
export function parseHeaderFields(raw: Uint8Array): Record<string, string> {
  return splitHeaders(splitHeaderBody(raw).head);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeQuotedPrintable(value: string): Uint8Array {
  const flat = value.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < flat.length; i += 1) {
    const char = flat[i]!;
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(flat.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(flat.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    bytes.push(char.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(bytes);
}

function decodeBody(body: Uint8Array, encoding: string): Uint8Array {
  const kind = encoding.trim().toLowerCase();
  if (kind === "base64") return decodeBase64(LATIN1.decode(body));
  if (kind === "quoted-printable") {
    return decodeQuotedPrintable(LATIN1.decode(body));
  }
  return body;
}

function charsetOf(contentType: string): string {
  const match = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
  const name = (match?.[1] ?? "utf-8").trim().toLowerCase();
  try {
    new TextDecoder(name);
    return name;
  } catch {
    return "utf-8";
  }
}

function decodeText(bytes: Uint8Array, contentType: string): string {
  return new TextDecoder(charsetOf(contentType)).decode(bytes);
}

/**
 * RFC 2047 encoded words, e.g. `=?GBK?B?0MLCtg==?=`. Whitespace between two
 * adjacent encoded words is not part of the text (RFC 2047 §6.2), so a folded
 * subject decodes to one run instead of words joined by spaces.
 */
export function decodeWords(value: string): string {
  return value.replace(/\?=\s+=\?/g, "?==?").replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_all, charset: string, kind: string, text: string) => {
      try {
        const bytes =
          kind.toUpperCase() === "B"
            ? decodeBase64(text)
            : decodeQuotedPrintable(text.replace(/_/g, " "));
        return new TextDecoder(charset.trim().toLowerCase()).decode(bytes);
      } catch {
        return text;
      }
    },
  );
}

function param(header: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, "i").exec(header);
  return match?.[1]?.trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Collected = {
  plain: string | undefined;
  html: string | undefined;
  parts: ParsedPart[];
};

function collect(
  body: Uint8Array,
  headers: Record<string, string>,
  collected: Collected,
): void {
  const contentType = decodeWords(
    headers["content-type"] ?? "text/plain; charset=utf-8",
  );
  const disposition = headers["content-disposition"] ?? "";
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  const boundary = param(contentType, "boundary");

  if (mime.startsWith("multipart/") && boundary !== undefined) {
    for (const part of splitParts(body, boundary)) {
      const split = splitHeaderBody(part);
      collect(split.body, splitHeaders(split.head), collected);
    }
    return;
  }

  const decoded = decodeBody(body, headers["content-transfer-encoding"] ?? "");
  const filename = param(disposition, "filename") ?? param(contentType, "name");

  if (
    mime === "text/plain" &&
    filename === undefined &&
    collected.plain === undefined
  ) {
    collected.plain = decodeText(decoded, contentType);
    return;
  }
  if (
    mime === "text/html" &&
    filename === undefined &&
    collected.html === undefined
  ) {
    collected.html = htmlToText(decodeText(decoded, contentType));
    return;
  }
  if (filename !== undefined || !mime.startsWith("text/")) {
    collected.parts.push({
      filename: filename === undefined ? "attachment" : decodeWords(filename),
      size: decoded.length,
      contentType: mime,
      bytes: decoded,
    });
  }
}

export function parseMail(raw: Uint8Array): ParsedMail {
  const split = splitHeaderBody(raw);
  const rawHeaders = splitHeaders(split.head);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    headers[key] = decodeWords(value);
  }
  const collected: Collected = { plain: undefined, html: undefined, parts: [] };
  collect(split.body, rawHeaders, collected);
  return {
    headers,
    text: (collected.plain ?? collected.html ?? "").trim(),
    parts: collected.parts,
  };
}
