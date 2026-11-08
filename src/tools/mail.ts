import { Type } from "@earendil-works/pi-ai";
import type {
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { t, type Locale } from "../i18n";
import { resolveAccount, secretName, type MailAccount } from "../mail/accounts";
import {
  ImapError,
  classifyImapCommandError,
  openImap,
} from "../mail/imap";
import { decodeWords, parseHeaderFields, parseMail } from "../mail/mime";
import { cloudflareConnect, type SocketConnect } from "../mail/socket";

const MAX_MESSAGE_BYTES = 15 << 20;
const MAX_BODY_CHARS = 8000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const HEADER_FIELDS = "DATE FROM SUBJECT";
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const ASCII = /^[\x20-\x7e]*$/;

const MailSearch = Type.Object({
  account: Type.Optional(Type.String()),
  folder: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  from: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
  since: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
  before: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
  unreadOnly: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Number()),
});

const MailRead = Type.Object({
  account: Type.Optional(Type.String()),
  folder: Type.Optional(Type.String()),
  uid: Type.Integer({ minimum: 1 }),
});

export type MailToolDeps = {
  env: Env;
  locale: () => Locale;
  connect?: SocketConnect;
};

/** Fixed copy per failure bucket; the server's own words never reach the model. */
const ERROR_KEYS = {
  auth: "mail.error.auth",
  folder: "mail.error.folder",
  timeout: "mail.error.timeout",
  connect: "mail.error.connect",
} as const;

function ok(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }] };
}

function fail(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }], isError: true };
}

function errorText(locale: Locale, error: unknown): string {
  return t(locale, ERROR_KEYS[classifyImapCommandError(error)]);
}

function passwordOf(env: Env, account: MailAccount): string {
  const value = env[secretName(account.id) as keyof Env];
  return typeof value === "string" ? value : "";
}

function endpointOf(account: MailAccount) {
  return {
    hostname: account.imap.host,
    port: account.imap.port,
    security: account.imap.security,
  };
}

/** IMAP quoted string: backslash before quote, or the server mis-parses both. */
function imapQuoted(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new ImapError("value has a control character", "BAD");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** The caller's own words are the only place a CRLF can reach a command. */
function hasControlChars(values: (string | undefined)[]): boolean {
  return values.some(
    (value) => value !== undefined && /[\r\n\0]/.test(value),
  );
}

function imapDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) return null;
  return `${Number(match[3])}-${month}-${match[1]}`;
}

function criteriaOf(args: {
  query?: string;
  from?: string;
  subject?: string;
  since?: string;
  before?: string;
  unreadOnly?: boolean;
}): { criteria: string; charset: "UTF-8" | undefined } {
  const parts: string[] = [];
  let charset: "UTF-8" | undefined;

  const text = (command: string, value: string) => {
    parts.push(`${command} ${imapQuoted(value)}`);
    if (!ASCII.test(value)) charset = "UTF-8";
  };

  if (args.query !== undefined) text("TEXT", args.query);
  if (args.from !== undefined) text("FROM", args.from);
  if (args.subject !== undefined) text("SUBJECT", args.subject);
  const since = args.since === undefined ? null : imapDate(args.since);
  if (since !== null) parts.push(`SINCE ${since}`);
  const before = args.before === undefined ? null : imapDate(args.before);
  if (before !== null) parts.push(`BEFORE ${before}`);
  if (args.unreadOnly === true) parts.push("UNSEEN");
  if (parts.length === 0) parts.push("ALL");

  return { criteria: parts.join(" "), charset };
}

/** First `{n}` literal payload of a FETCH response, byte-exact. */
function literalOf(response: Uint8Array): Uint8Array {
  const text = new TextDecoder("latin1").decode(response);
  const match = /\{(\d+)\}\r\n/.exec(text);
  if (match === null) return new Uint8Array(0);
  const start = match.index + match[0].length;
  return response.slice(start, start + Number(match[1]));
}

function display(value: string | undefined): string {
  return value === undefined ? "" : decodeWords(value);
}

export function mailSearchTool(
  accounts: MailAccount[],
  deps: MailToolDeps,
): ToolRegistration<typeof MailSearch> {
  const connect = deps.connect ?? cloudflareConnect;

  return {
    name: "mail_search",
    description:
      "Search the owner's mailbox headers: returns uid, date, sender, subject and unread flags. " +
      "Read one message with mail_read uid. Read-only: it never marks anything as read.",
    parameters: MailSearch,
    replay: "safe",
    async execute(args, _api, context): Promise<ToolExecutionResult> {
      const locale = deps.locale();
      const account = resolveAccount(accounts, args.account);
      if (account === null) {
        return fail(
          args.account === undefined
            ? t(locale, "mail.error.connect")
            : t(locale, "mail.error.account", { id: args.account }),
        );
      }

      if (hasControlChars([args.query, args.from, args.subject, args.folder])) {
        return fail(t(locale, "mail.error.term"));
      }

      const limit = Math.min(
        Math.max(args.limit ?? DEFAULT_LIMIT, 1),
        MAX_LIMIT,
      );
      const { criteria, charset } = criteriaOf(args);

      let imap: Awaited<ReturnType<typeof openImap>>;
      try {
        imap = await openImap(
          connect,
          endpointOf(account),
          account.user,
          passwordOf(deps.env, account),
          { signal: context.abortSignal },
        );
      } catch (error) {
        return fail(errorText(locale, error));
      }

      try {
        await imap.select(args.folder ?? "INBOX");

        let uids: number[];
        let degraded = false;
        try {
          uids = await imap.uidSearch(criteria, charset);
        } catch (error) {
          const refused =
            charset !== undefined &&
            error instanceof ImapError &&
            (error.status === "BAD" || error.status === "NO");
          if (!refused) throw error;
          // The server refused the charset: scan the newest headers instead.
          degraded = true;
          uids = (await imap.uidSearch("ALL")).slice(-limit * 5);
        }
        if (uids.length === 0) return ok(t(locale, "mail.result.empty"));

        const selected = uids.slice(-limit).reverse();
        const rows: string[] = [];
        for (const uid of selected) {
          const response = await imap.uidFetch(
            uid,
            `BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})]`,
          );
          const headers = parseHeaderFields(literalOf(response));
          rows.push(
            [
              `uid ${uid}`,
              headers.date ?? "",
              display(headers.from),
              display(headers.subject),
            ]
              .filter((cell) => cell !== "")
              .join(" · "),
          );
        }

        const summary = [
          t(locale, "mail.result.list", {
            total: uids.length,
            shown: selected.length,
            account: account.id,
          }),
        ];
        if (degraded) {
          summary.push(
            t(locale, "mail.result.headerOnly", { scanned: uids.length }),
          );
        }
        return ok([rows.join("\n"), summary.join(" ")].join("\n"));
      } catch (error) {
        return fail(errorText(locale, error));
      } finally {
        await imap.logout().catch(() => {});
      }
    },
  };
}

export function mailReadTool(
  accounts: MailAccount[],
  deps: MailToolDeps,
): ToolRegistration<typeof MailRead> {
  const connect = deps.connect ?? cloudflareConnect;

  return {
    name: "mail_read",
    description:
      "Read one message by uid: decoded plain-text body plus the attachment list. " +
      "Bodies over 8000 characters are truncated; messages over 15 MB are refused.",
    parameters: MailRead,
    replay: "safe",
    async execute(args, _api, context): Promise<ToolExecutionResult> {
      const locale = deps.locale();
      const account = resolveAccount(accounts, args.account);
      if (account === null) return fail(t(locale, "mail.error.connect"));

      let imap: Awaited<ReturnType<typeof openImap>>;
      try {
        imap = await openImap(
          connect,
          endpointOf(account),
          account.user,
          passwordOf(deps.env, account),
          { signal: context.abortSignal },
        );
      } catch (error) {
        return fail(errorText(locale, error));
      }

      try {
        await imap.select(args.folder ?? "INBOX");

        const meta = await imap.uidFetch(args.uid, "RFC822.SIZE");
        const sizeMatch = /RFC822\.SIZE (\d+)/.exec(
          new TextDecoder("latin1").decode(meta),
        );
        const size = sizeMatch === null ? 0 : Number(sizeMatch[1]);
        if (size > MAX_MESSAGE_BYTES) {
          return fail(
            t(locale, "mail.error.tooLarge", {
              size: (size / (1024 * 1024)).toFixed(1),
            }),
          );
        }

        const raw = literalOf(await imap.uidFetch(args.uid, "BODY.PEEK[]"));
        if (raw.length === 0) return fail(t(locale, "mail.error.missing"));

        const parsed = parseMail(raw);
        const truncated = parsed.text.length > MAX_BODY_CHARS;
        const body =
          parsed.text === ""
            ? t(locale, "mail.result.noBody")
            : truncated
              ? `${parsed.text.slice(0, MAX_BODY_CHARS)}\n…`
              : parsed.text;

        const lines = [
          `Subject: ${parsed.headers.subject ?? ""}`,
          `From: ${parsed.headers.from ?? ""}`,
          `Date: ${parsed.headers.date ?? ""}`,
          `Message-ID: ${parsed.headers["message-id"] ?? ""}`,
          "",
          body,
        ];
        if (truncated) {
          lines.push(
            "",
            t(locale, "mail.result.truncated", { total: parsed.text.length }),
          );
        }
        if (parsed.parts.length > 0) {
          lines.push(
            "",
            t(locale, "mail.result.attachments", {
              count: parsed.parts.length,
              list: parsed.parts
                .map(
                  (part, index) =>
                    `${index}: ${part.filename} (${part.size}B ${part.contentType})`,
                )
                .join(", "),
            }),
          );
        }
        return ok(lines.join("\n"));
      } catch (error) {
        return fail(errorText(locale, error));
      } finally {
        await imap.logout().catch(() => {});
      }
    },
  };
}

/** Progress line for `withProgress`; Task 7 wires it. */
export function mailProgressText(
  name: string,
  args: unknown,
  locale: Locale,
): string {
  const value = (args ?? {}) as { query?: unknown; uid?: unknown };
  if (name === "mail_search") {
    const query = typeof value.query === "string" ? value.query : "ALL";
    return t(locale, "mail.progress.search", { query });
  }
  const uid = typeof value.uid === "number" ? value.uid : 0;
  return t(locale, "mail.progress.read", { uid });
}
