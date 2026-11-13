import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { fakeConnect } from "../helpers/fake-socket";
import { mailReadTool, mailSearchTool } from "../../src/tools/mail";

const account = {
  id: "main",
  user: "me@example.com",
  imap: { host: "imap.test", port: 993, security: "tls" as const },
};

const env = { EMAIL_SECRET_MAIN: "pw" } as unknown as Env;

const context = () => ({ abortSignal: undefined } as unknown as Context);

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

/** One FETCH response: the literal payload followed by the tagged completion. */
function fetchResponse(payload: Uint8Array, tag: string): Uint8Array {
  return concat([
    bytes(`* 1 FETCH (UID 7 BODY[] {${payload.length}}\r\n`),
    payload,
    bytes(`\r\n)\r\n${tag} OK done\r\n`),
  ]);
}

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

describe("mail_search", () => {
  it("lists decoded headers with owner-facing counts", async () => {
    const header = bytes(
      "Date: Wed, 5 Nov 2026 10:00:00 +0800\r\n" +
        "From: Invoice <bill@example.com>\r\n" +
        "Subject: =?GBK?B?t6LGsQ==?=\r\n" +
        "\r\n",
    );
    const connect = fakeConnect({
      greeting: "* OK ready\r\n",
      respond: (line) => {
        if (line.startsWith("a1 LOGIN")) return "a1 OK\r\n";
        if (line.startsWith("a2 SELECT")) return "* 2 EXISTS\r\na2 OK\r\n";
        if (line.startsWith("a3 UID SEARCH")) return "* SEARCH 7\r\na3 OK\r\n";
        if (line.startsWith("a4 UID FETCH")) return fetchResponse(header, "a4");
        if (line.startsWith("a5 LOGOUT")) return "* BYE\r\na5 OK\r\n";
        return undefined;
      },
    });

    const tool = mailSearchTool([account], { env, locale: () => "zh", connect });
    const text = textOf(
      await tool.execute({ query: "invoice" }, {} as never, context()),
    );

    expect(text).toContain("发票");
    expect(text).toContain("bill@example.com");
    expect(text).toContain("共 1 封");
  });

  it("escapes quotes and backslashes in the search criteria", async () => {
    let sent = "";
    const connect = fakeConnect({
      greeting: "* OK ready\r\n",
      respond: (line) => {
        if (line.startsWith("a1 LOGIN")) return "a1 OK\r\n";
        if (line.startsWith("a2 SELECT")) return "* 0 EXISTS\r\na2 OK\r\n";
        if (line.startsWith("a3 UID SEARCH")) {
          sent = line;
          return "* SEARCH\r\na3 OK\r\n";
        }
        if (line.startsWith("a4 LOGOUT")) return "* BYE\r\na4 OK\r\n";
        return undefined;
      },
    });

    const tool = mailSearchTool([account], { env, locale: () => "zh", connect });
    await tool.execute({ subject: 'a"b\\c' }, {} as never, context());

    expect(sent).toBe('a3 UID SEARCH SUBJECT "a\\"b\\\\c"');
  });

  it("reports a rejected login as an auth error", async () => {
    const connect = fakeConnect({
      greeting: "* OK ready\r\n",
      respond: () => "a1 NO bad credentials\r\n",
    });

    const tool = mailSearchTool([account], { env, locale: () => "zh", connect });
    const text = textOf(await tool.execute({}, {} as never, context()));

    expect(text).toContain("授权码");
  });

  it("rejects an unknown account id without connecting", async () => {
    let connected = 0;
    const base = fakeConnect({ greeting: "", respond: () => undefined });
    const tool = mailSearchTool([account], {
      env,
      locale: () => "zh",
      connect: (point) => {
        connected += 1;
        return base(point);
      },
    });

    const text = textOf(
      await tool.execute({ account: "nope" }, {} as never, context()),
    );

    expect(text).toContain("nope");
    expect(connected).toBe(0);
  });
});

describe("mail_read", () => {
  it("returns the decoded subject and body", async () => {
    const raw = bytes(
      "Subject: =?GBK?B?t6LGsQ==?=\r\n" +
        "Content-Type: text/plain; charset=UTF-8\r\n" +
        "\r\n" +
        "你好\r\n",
    );
    const connect = fakeConnect({
      greeting: "* OK ready\r\n",
      respond: (line) => {
        if (line.startsWith("a1 LOGIN")) return "a1 OK\r\n";
        if (line.startsWith("a2 SELECT")) return "* 2 EXISTS\r\na2 OK\r\n";
        if (line.includes("RFC822.SIZE")) {
          return `* 1 FETCH (UID 7 RFC822.SIZE ${raw.length})\r\na3 OK\r\n`;
        }
        if (line.startsWith("a4 UID FETCH")) return fetchResponse(raw, "a4");
        if (line.startsWith("a5 LOGOUT")) return "* BYE\r\na5 OK\r\n";
        return undefined;
      },
    });

    const tool = mailReadTool([account], { env, locale: () => "zh", connect });
    const text = textOf(await tool.execute({ uid: 7 }, {} as never, context()));

    expect(text).toContain("发票");
    expect(text).toContain("你好");
  });

  it("refuses a message over 15 MB before downloading it", async () => {
    const connect = fakeConnect({
      greeting: "* OK ready\r\n",
      respond: (line) => {
        if (line.startsWith("a1 LOGIN")) return "a1 OK\r\n";
        if (line.startsWith("a2 SELECT")) return "* 1 EXISTS\r\na2 OK\r\n";
        if (line.includes("RFC822.SIZE")) {
          return `* 1 FETCH (UID 7 RFC822.SIZE ${16 << 20})\r\na3 OK\r\n`;
        }
        if (line.startsWith("a4 LOGOUT")) return "* BYE\r\na4 OK\r\n";
        return undefined;
      },
    });

    const tool = mailReadTool([account], { env, locale: () => "zh", connect });
    const text = textOf(await tool.execute({ uid: 7 }, {} as never, context()));

    expect(text).toContain("16.0 MB");
  });
});

describe("mail_search guards", () => {
  it("refuses a search term that would break the IMAP command line", async () => {
    let connected = 0;
    const base = fakeConnect({ greeting: "", respond: () => undefined });
    const tool = mailSearchTool([account], {
      env,
      locale: () => "zh",
      connect: (point) => {
        connected += 1;
        return base(point);
      },
    });

    const result = await tool.execute(
      { subject: "hello\r\nA2 DELETE" },
      {} as never,
      context(),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("换行");
    expect(connected).toBe(0);
  });

  it("does not report a refused plain search as a header-only scan", async () => {
    const connect = fakeConnect({
      greeting: "* OK ready\r\n",
      respond: (line) => {
        if (line.startsWith("a1 LOGIN")) return "a1 OK\r\n";
        if (line.startsWith("a2 SELECT")) return "* 2 EXISTS\r\na2 OK\r\n";
        if (line.startsWith("a3 UID SEARCH")) return "a3 NO [BOGUS] bad search\r\n";
        if (line.startsWith("a4 LOGOUT")) return "* BYE\r\na4 OK\r\n";
        return undefined;
      },
    });

    const tool = mailSearchTool([account], { env, locale: () => "zh", connect });
    const result = await tool.execute({ query: "invoice" }, {} as never, context());

    // A plain ASCII search that the server refuses is an error, not a reason
    // to silently return the newest headers as if they matched.
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("共 1 封");
  });
});
