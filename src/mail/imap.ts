import type { SocketConnect, SocketTarget } from "./socket";

const CRLF = "\r\n";
const DEFAULT_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 8_000;
/** A literal this large is a broken or hostile server, not a message. */
const MAX_LITERAL_BYTES = 16 << 20;
const LATIN1 = new TextDecoder("latin1");
const CRLF_BYTES = [0x0d, 0x0a];

export class ImapError extends Error {
  constructor(
    message: string,
    readonly status: "NO" | "BAD" | "BYE" | "TIMEOUT",
    /** Set by the call site, which knows what the command was for. */
    readonly hint?: "auth" | "folder",
  ) {
    super(message);
    this.name = "ImapError";
  }
}

/** Maps a thrown error onto the fixed copy bucket the tools report. */
export function classifyImapCommandError(
  error: unknown,
): "auth" | "folder" | "timeout" | "connect" {
  if (!(error instanceof ImapError)) return "connect";
  if (error.hint !== undefined) return error.hint;
  return error.status === "TIMEOUT" ? "timeout" : "connect";
}

export type Imap = {
  select(folder: string): Promise<{ exists: number }>;
  uidSearch(criteria: string, charset?: "UTF-8"): Promise<number[]>;
  uidFetch(uid: number, items: string): Promise<Uint8Array>;
  logout(): Promise<void>;
  close(): Promise<void>;
};

/**
 * `timeoutMs` is the budget for the whole session, not one command: a search
 * issues one command per message, so a per-command budget would let a slow
 * server hold the tool for minutes.
 */
export type OpenImapOptions = { timeoutMs?: number; signal?: AbortSignal };

function indexOfBytes(
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
 * Where the response ends (`end`, -1 while incomplete) and where scanning may
 * resume next time (`resume`). Resuming matters: a 15 MB literal would
 * otherwise be rescanned from byte 0 on every chunk.
 */
function scanResponse(
  bytes: Uint8Array,
  tag: string,
  from: number,
): { end: number; resume: number } {
  let offset = from;
  while (offset < bytes.length) {
    const eol = indexOfBytes(bytes, CRLF_BYTES, offset);
    if (eol < 0) return { end: -1, resume: offset };
    const line = LATIN1.decode(bytes.subarray(offset, eol));
    const literal = /\{(\d+)\}$/.exec(line);
    if (literal) {
      const start = eol + 2;
      const size = Number(literal[1]);
      if (size > MAX_LITERAL_BYTES) {
        throw new ImapError("literal too large", "BAD");
      }
      if (bytes.length < start + size) return { end: -1, resume: offset };
      offset = start + size;
      continue;
    }
    if (line.startsWith(`${tag} `)) return { end: eol + 2, resume: 0 };
    offset = eol + 2;
  }
  return { end: -1, resume: offset };
}

type Session = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  /** Received bytes, with capacity that doubles instead of reallocating per chunk. */
  buffer: Uint8Array;
  length: number;
  tag: number;
  /** Wall-clock deadline for the whole session. */
  deadline: number;
  signal: AbortSignal | undefined;
};

function pendingOf(session: Session): Uint8Array {
  return session.buffer.subarray(0, session.length);
}

function appendTo(session: Session, chunk: Uint8Array): void {
  const needed = session.length + chunk.length;
  if (needed > session.buffer.length) {
    let capacity = Math.max(1024, session.buffer.length);
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(pendingOf(session));
    session.buffer = grown;
  }
  session.buffer.set(chunk, session.length);
  session.length = needed;
}

function consumeFrom(session: Session, count: number): void {
  session.length -= count;
  if (session.length > 0) {
    session.buffer.copyWithin(0, count, count + session.length);
  }
}

function remainingMs(session: Session): number {
  return session.deadline - Date.now();
}

async function fill(session: Session, timeoutMs: number): Promise<void> {
  const { signal } = session;
  if (signal?.aborted) throw new ImapError("aborted", "BYE");

  const waiting: Promise<"aborted" | "timeout" | ReadableStreamReadResult<Uint8Array>>[] = [
    session.reader.read(),
    new Promise((resolve) =>
      setTimeout(() => resolve("timeout"), Math.max(1, timeoutMs)),
    ),
  ];
  if (signal !== undefined) {
    waiting.push(
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve("aborted"), {
          once: true,
        });
      }),
    );
  }

  const read = await Promise.race(waiting);
  if (read === "timeout") throw new ImapError("imap timeout", "TIMEOUT");
  if (read === "aborted") throw new ImapError("aborted", "BYE");
  if (read.done) throw new ImapError("imap connection closed", "BYE");
  appendTo(session, read.value);
}

async function readUntil(
  session: Session,
  tag: string,
): Promise<Uint8Array> {
  let scan = 0;
  for (;;) {
    const result = scanResponse(pendingOf(session), tag, scan);
    if (result.end >= 0) {
      const response = pendingOf(session).slice(0, result.end);
      consumeFrom(session, result.end);
      return response;
    }
    scan = result.resume;
    const remaining = remainingMs(session);
    if (remaining <= 0) throw new ImapError("imap timeout", "TIMEOUT");
    await fill(session, remaining);
  }
}

/** The greeting is untagged: read exactly one line before the first command. */
async function readGreeting(session: Session): Promise<void> {
  for (;;) {
    const eol = indexOfBytes(pendingOf(session), CRLF_BYTES, 0);
    if (eol >= 0) {
      consumeFrom(session, eol + 2);
      return;
    }
    const remaining = remainingMs(session);
    if (remaining <= 0) throw new ImapError("greeting timeout", "TIMEOUT");
    await fill(session, remaining);
  }
}

async function command(session: Session, line: string): Promise<Uint8Array> {
  if (remainingMs(session) <= 0) {
    throw new ImapError("imap timeout", "TIMEOUT");
  }
  session.tag += 1;
  const tag = `a${session.tag}`;
  await session.writer.write(new TextEncoder().encode(`${tag} ${line}${CRLF}`));
  const response = await readUntil(session, tag);
  const statusLine = LATIN1.decode(response)
    .split(CRLF)
    .find((part) => part.startsWith(`${tag} `));
  if (statusLine === undefined) throw new ImapError("missing status", "BYE");
  if (statusLine.startsWith(`${tag} OK`)) return response;
  throw new ImapError(
    statusLine,
    statusLine.startsWith(`${tag} NO`) ? "NO" : "BAD",
  );
}

function firstLine(
  response: Uint8Array,
  pattern: RegExp,
): RegExpExecArray | null {
  for (const line of LATIN1.decode(response).split(CRLF)) {
    const match = pattern.exec(line);
    if (match) return match;
  }
  return null;
}

async function rehint<T>(
  hint: "auth" | "folder",
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ImapError && error.status !== "TIMEOUT") {
      throw new ImapError(error.message, error.status, hint);
    }
    throw error;
  }
}

/** IMAP quoted string: backslash and double quote are the only escapes. */
function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export async function openImap(
  connect: SocketConnect,
  target: SocketTarget,
  user: string,
  password: string,
  options: OpenImapOptions = {},
): Promise<Imap> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = connect(target);
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const session: Session = {
    reader,
    writer,
    buffer: new Uint8Array(1024),
    length: 0,
    tag: 0,
    deadline: Date.now() + timeoutMs,
    signal: options.signal,
  };

  const close = async () => {
    try {
      await reader.cancel();
    } catch {
      // The socket may already be gone; closing twice must stay quiet.
    }
    await socket.close().catch(() => {});
  };

  try {
    const opened = await Promise.race([
      socket.opened.then(() => "opened" as const),
      new Promise<"timeout">((resolve) =>
        setTimeout(
          () => resolve("timeout"),
          Math.max(1, Math.min(CONNECT_TIMEOUT_MS, timeoutMs)),
        ),
      ),
    ]);
    if (opened === "timeout") throw new ImapError("connect timeout", "TIMEOUT");

    await readGreeting(session);
    await rehint("auth", () =>
      command(session, `LOGIN ${quote(user)} ${quote(password)}`),
    );
  } catch (error) {
    await close();
    throw error;
  }

  return {
    async select(folder) {
      const response = await rehint("folder", () =>
        command(session, `SELECT ${quote(folder)}`),
      );
      const exists = firstLine(response, /^\* (\d+) EXISTS$/);
      return { exists: exists ? Number(exists[1]) : 0 };
    },
    async uidSearch(criteria, charset) {
      const head =
        charset === undefined ? "UID SEARCH" : `UID SEARCH CHARSET ${charset}`;
      const response = await command(session, `${head} ${criteria}`);
      const line = firstLine(response, /^\* SEARCH(.*)$/);
      if (line === null) return [];
      return line[1]!
        .trim()
        .split(/\s+/)
        .filter((part) => part !== "")
        .map(Number);
    },
    async uidFetch(uid, items) {
      return command(session, `UID FETCH ${uid} (${items})`);
    },
    async logout() {
      try {
        // Out of time: closing is enough, the server sees the socket go away.
        if (remainingMs(session) > 0) await command(session, "LOGOUT");
      } finally {
        await close();
      }
    },
    close,
  };
}
