import type { MailSocket, SocketConnect } from "../../src/mail/socket";

/**
 * In-memory mail server: replies to each CRLF-terminated command. A reply may
 * be a string or raw bytes (literal payloads); `undefined` means the server
 * stays silent, which is how timeouts and aborts are exercised.
 */
export function fakeConnect(options: {
  greeting: string;
  respond: (
    command: string,
  ) => string | Uint8Array | undefined | Promise<string | Uint8Array | undefined>;
}): SocketConnect {
  return () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let closed = false;
    let push: (chunk: Uint8Array) => void = () => {};

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => {
          if (!closed) controller.enqueue(chunk);
        };
      },
    });

    const send = (reply: string | Uint8Array) =>
      push(typeof reply === "string" ? encoder.encode(reply) : reply);

    let pending = "";
    const writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        pending += decoder.decode(chunk, { stream: true });
        let index = pending.indexOf("\r\n");
        while (index >= 0) {
          const command = pending.slice(0, index);
          pending = pending.slice(index + 2);
          const reply = await options.respond(command);
          if (reply !== undefined) send(reply);
          index = pending.indexOf("\r\n");
        }
      },
    });

    send(options.greeting);

    return {
      opened: Promise.resolve(),
      readable,
      writable,
      async close() {
        closed = true;
        await readable.cancel().catch(() => {});
      },
    } satisfies MailSocket;
  };
}
