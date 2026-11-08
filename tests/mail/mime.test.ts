import { describe, expect, it } from "vitest";
import { decodeWords, parseHeaderFields, parseMail } from "../../src/mail/mime";

const encoder = new TextEncoder();

function mail(headers: string, body: string | Uint8Array): Uint8Array {
  const head = encoder.encode(`${headers}\r\n\r\n`);
  const tail = typeof body === "string" ? encoder.encode(body) : body;
  const out = new Uint8Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
}

describe("parseMail", () => {
  it("decodes a folded RFC 2047 GBK subject", () => {
    // 「发票」in GBK is d0 c2 c6 b1; base64 of it is t6LGsQ==
    const raw = mail(
      [
        "From: a@example.com",
        "Subject: =?GBK?B?t6LGsQ==?=",
        "\t=?GBK?B?t6LGsQ==?=",
        "Content-Type: text/plain; charset=GBK",
        "Content-Transfer-Encoding: 8bit",
      ].join("\r\n"),
      new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]),
    );

    const parsed = parseMail(raw);
    expect(parsed.headers.subject).toBe("发票发票");
    expect(parsed.text).toBe("中文");
  });

  it("decodes base64 and quoted-printable bodies", () => {
    const base64 = parseMail(
      mail(
        "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64",
        "5L2g5aW9",
      ),
    );
    expect(base64.text).toBe("你好");

    const qp = parseMail(
      mail(
        "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable",
        "h=C3=A9llo=20there",
      ),
    );
    expect(qp.text).toBe("héllo there");
  });

  it("keeps binary attachment bytes intact through a nested multipart", () => {
    // 0x80-0xff bytes are not valid UTF-8: a latin1 decode + re-encode would
    // turn each of them into two bytes and corrupt the attachment.
    const binary = new Uint8Array([0x00, 0x80, 0xff, 0x41]);
    const head = [
      "--outer",
      'Content-Type: multipart/alternative; boundary="inner"',
      "",
      "--inner",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "plain body",
      "--inner--",
      "--outer",
      'Content-Type: application/octet-stream; name="blob.bin"',
      'Content-Disposition: attachment; filename="blob.bin"',
      "Content-Transfer-Encoding: 8bit",
      "",
      "",
    ].join("\r\n");
    const body = new Uint8Array([
      ...encoder.encode(head),
      ...binary,
      ...encoder.encode("\r\n--outer--\r\n"),
    ]);

    const parsed = parseMail(
      mail(
        'Content-Type: multipart/mixed; boundary="outer"\r\nSubject: report',
        body,
      ),
    );

    expect(parsed.text).toBe("plain body");
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0]!.filename).toBe("blob.bin");
    expect(parsed.parts[0]!.contentType).toBe("application/octet-stream");
    expect([...parsed.parts[0]!.bytes]).toEqual([...binary]);
  });

  it("decodes base64 attachments", () => {
    const raw = mail(
      'Content-Type: multipart/mixed; boundary="b"',
      [
        "--b",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="invoice.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "JVBERi0=",
        "--b--",
        "",
      ].join("\r\n"),
    );

    const parsed = parseMail(raw);
    expect(parsed.parts).toHaveLength(1);
    expect([...parsed.parts[0]!.bytes]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
  });

  it("falls back to html text when there is no plain part", () => {
    const raw = mail(
      "Content-Type: text/html; charset=UTF-8",
      "<p>hello<br>world</p>",
    );
    expect(parseMail(raw).text).toBe("hello\nworld");
  });

  it("decodes an encoded word on its own and unfolds header fields", () => {
    expect(decodeWords("=?GBK?B?t6LGsQ==?=")).toBe("发票");

    const headers = parseHeaderFields(
      encoder.encode(
        "Subject: =?GBK?B?t6LGsQ==?=\r\n\tcontinued\r\nFrom: a@example.com\r\nFrom: b@example.com\r\n\r\n",
      ),
    );
    // Decoding is parseMail's job; here the raw encoded word must survive.
    expect(headers.subject).toBe("=?GBK?B?t6LGsQ==?= continued");
    expect(headers.from).toBe("a@example.com");
  });
});
