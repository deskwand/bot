import { connect } from "cloudflare:sockets";

/** How the connection is encrypted. */
export type MailSecurity = "tls" | "starttls";

export type SocketTarget = {
  hostname: string;
  port: number;
  security: MailSecurity;
};

/**
 * The subset of a Workers socket the mail subsystem uses. Declared here so IMAP
 * and SMTP take an injected connection and tests never touch the network.
 */
export type MailSocket = {
  opened: Promise<unknown>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
};

export type SocketConnect = (target: SocketTarget) => MailSocket;

/** `tls` is implicit TLS (993/465); `starttls` upgrades after the greeting. */
export const cloudflareConnect: SocketConnect = ({ hostname, port, security }) =>
  connect(
    { hostname, port },
    {
      secureTransport: security === "tls" ? "on" : "starttls",
      // The typed option is required but its default is what we want: closing
      // the readable side also ends the writable side.
      allowHalfOpen: false,
    },
  ) as unknown as MailSocket;
