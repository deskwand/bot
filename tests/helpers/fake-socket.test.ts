import { describe, expect, it } from "vitest";
import { fakeConnect } from "./fake-socket";

describe("fakeConnect", () => {
  it("greets on open and answers written commands line by line", async () => {
    const connect = fakeConnect({
      greeting: "* OK ready\r\n",
      respond: (line) => (line === "a1 NOOP" ? "a1 OK done\r\n" : "a1 BAD\r\n"),
    });

    const socket = connect({ hostname: "imap.test", port: 993, security: "tls" });
    const reader = socket.readable.getReader();
    const decoder = new TextDecoder();
    const next = async () => decoder.decode((await reader.read()).value);

    expect(await next()).toBe("* OK ready\r\n");

    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode("a1 NOOP\r\n"));
    expect(await next()).toBe("a1 OK done\r\n");
  });

  it("can reply with raw bytes", async () => {
    const connect = fakeConnect({
      greeting: "* OK ready\r\n",
      respond: () => new Uint8Array([0x00, 0xff]),
    });

    const socket = connect({ hostname: "imap.test", port: 993, security: "tls" });
    const reader = socket.readable.getReader();
    await reader.read();

    await socket.writable.getWriter().write(new TextEncoder().encode("a1 X\r\n"));
    expect([...(await reader.read()).value!]).toEqual([0x00, 0xff]);
  });
});
