import { describe, expect, it } from "vitest";
import { fakeConnect } from "../helpers/fake-socket";
import {
  ImapError,
  classifyImapCommandError,
  openImap,
} from "../../src/mail/imap";

const target = { hostname: "imap.test", port: 993, security: "tls" as const };

const GREETING = "* OK IMAP4rev1 ready\r\n";
const LOGIN_OK = "a1 OK logged in\r\n";
const SELECT_OK = "* 3 EXISTS\r\na2 OK [READ-ONLY] done\r\n";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("openImap", () => {
  it("logs in, selects a folder and reads EXISTS", async () => {
    const connect = fakeConnect({
      greeting: GREETING,
      respond: (line) => {
        if (line.startsWith("a1 LOGIN")) return LOGIN_OK;
        if (line.startsWith("a2 SELECT")) return SELECT_OK;
        if (line.startsWith("a3 LOGOUT")) return "* BYE\r\na3 OK bye\r\n";
        return undefined;
      },
    });

    const imap = await openImap(connect, target, "me@example.com", "secret");
    await expect(imap.select("INBOX")).resolves.toEqual({ exists: 3 });
    await imap.logout();
  });

  it("reports a rejected login as an auth failure", async () => {
    const connect = fakeConnect({
      greeting: GREETING,
      respond: () => "a1 NO [AUTHENTICATIONFAILED] bad credentials\r\n",
    });

    await expect(
      openImap(connect, target, "me@example.com", "wrong"),
    ).rejects.toBeInstanceOf(ImapError);

    const again = fakeConnect({
      greeting: GREETING,
      respond: () => "a1 NO [AUTHENTICATIONFAILED] bad credentials\r\n",
    });
    await expect(
      openImap(again, target, "me@example.com", "wrong").catch(
        classifyImapCommandError,
      ),
    ).resolves.toBe("auth");
  });

  it("reads a response whose literal holds GBK bytes", async () => {
    // 「中文」in GBK is d6 d0 ce c4: not valid UTF-8, so the client must skip
    // the literal by byte count instead of decoding the response as text.
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const response = concat([
      bytes(
        `* 1 FETCH (UID 7 BODY[HEADER.FIELDS (SUBJECT)] {${gbk.length}}\r\n`,
      ),
      gbk,
      bytes("\r\n)\r\na2 OK done\r\n"),
    ]);

    const connect = fakeConnect({
      greeting: GREETING,
      respond: (line) => {
        if (line.startsWith("a1 LOGIN")) return LOGIN_OK;
        if (line.startsWith("a2 UID FETCH")) return response;
        if (line.startsWith("a3 SELECT")) return "* 1 EXISTS\r\na3 OK\r\n";
        if (line.startsWith("a4 LOGOUT")) return "* BYE\r\na4 OK\r\n";
        return undefined;
      },
    });

    const imap = await openImap(connect, target, "me@example.com", "secret");
    const fetched = await imap.uidFetch(7, "BODY.PEEK[HEADER.FIELDS (SUBJECT)]");

    expect(fetched.length).toBe(response.length);

    // The stream stayed in sync: the next command still gets its own answer.
    await expect(imap.select("INBOX")).resolves.toEqual({ exists: 1 });
    await imap.logout();
  });

  it("refuses a bad folder without reporting it as an auth problem", async () => {
    const connect = fakeConnect({
      greeting: GREETING,
      respond: (line) => {
        if (line.startsWith("a1 LOGIN")) return LOGIN_OK;
        return "a2 NO [NONEXISTENT] no such mailbox\r\n";
      },
    });

    const imap = await openImap(connect, target, "me@example.com", "secret");
    await expect(
      imap.select("Nope").catch(classifyImapCommandError),
    ).resolves.toBe("folder");
    await imap.close();
  });
});

it("closes the socket when the caller aborts", async () => {
  const controller = new AbortController();
  let closed = 0;
  const connect = fakeConnect({
    greeting: "* OK ready\r\n",
    respond: () => undefined, // stay silent so the login never completes
  });
  const tracked = (point: Parameters<typeof connect>[0]) => {
    const socket = connect(point);
    return {
      ...socket,
      async close() {
        closed += 1;
        await socket.close();
      },
    };
  };

  const opening = openImap(tracked, target, "me@example.com", "secret", {
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  controller.abort();

  await expect(opening).rejects.toBeInstanceOf(ImapError);
  expect(closed).toBeGreaterThan(0);
});

it("spends one time budget across commands, not one budget per command", async () => {
  // A slow server: each reply takes 60 ms. With a 100 ms budget for the whole
  // session, login succeeds and the next command must run out of time.
  const slow = (reply: string) => async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return reply;
  };
  const connect = fakeConnect({
    greeting: GREETING,
    respond: (line) => {
      if (line.startsWith("a1 LOGIN")) return slow(LOGIN_OK)();
      if (line.startsWith("a2 SELECT")) return slow("* 1 EXISTS\r\na2 OK\r\n")();
      return undefined;
    },
  });

  const started = Date.now();
  const imap = await openImap(connect, target, "me@example.com", "secret", {
    timeoutMs: 100,
  });
  await expect(imap.select("INBOX")).rejects.toBeInstanceOf(ImapError);
  expect(Date.now() - started).toBeLessThan(2_000);
  await imap.close();
});

it("stops a read when the caller aborts", async () => {
  const controller = new AbortController();
  const connect = fakeConnect({
    greeting: GREETING,
    respond: (line) => {
      if (line.startsWith("a1 LOGIN")) return LOGIN_OK;
      return undefined; // the fetch never answers
    },
  });

  const imap = await openImap(connect, target, "me@example.com", "secret", {
    signal: controller.signal,
  });
  const pending = imap.uidFetch(7, "BODY.PEEK[]");
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();

  await expect(pending).rejects.toBeInstanceOf(ImapError);
  await imap.close();
});

it("refuses a literal larger than the cap instead of buffering it", async () => {
  const connect = fakeConnect({
    greeting: GREETING,
    respond: (line) => {
      if (line.startsWith("a1 LOGIN")) return LOGIN_OK;
      // Declares 20 MB but never sends the payload.
      return "* 1 FETCH (UID 7 BODY[] {20971520}\r\n";
    },
  });

  const imap = await openImap(connect, target, "me@example.com", "secret", {
    timeoutMs: 5_000,
  });
  const started = Date.now();
  await expect(imap.uidFetch(7, "BODY.PEEK[]")).rejects.toBeInstanceOf(ImapError);
  expect(Date.now() - started).toBeLessThan(2_000);
  await imap.close();
});
