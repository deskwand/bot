import type { Messages } from "../messages";

export const mail: Messages["mail"] = {
  error: {
    connect: "Could not connect to the mailbox; check the server and port",
    auth: "The mailbox password or app password is wrong; update the secret on the desktop",
    folder: "That folder does not exist in this mailbox",
    missing: "That message is not in the mailbox; search again",
    account: "There is no mailbox account named {id}",
    term: "A search term cannot contain a line break",
    tooLarge: "The message is {size} MB, over the 15 MB limit",
    timeout: "The mailbox was too slow; nothing was read this time",
  },
  progress: {
    search: "Search mail: {query}",
    read: "Read mail: uid {uid}",
  },
  section: {
    title: "Mailbox accounts: {accounts}",
    rules: "Read-only: search, read bodies, list attachments. Never guess beyond these accounts.",
    omitted: "The first account is used when none is named.",
  },
  result: {
    empty: "No matching messages",
    list: "{total} messages, showing {shown} (account {account})",
    headerOnly: "Searched only the latest {scanned} headers (the server rejected the text search)",
    attachments: "{count} attachments: {list}",
    noBody: "This message has no readable body",
    truncated: "Body truncated; the original is {total} characters",
  },
};
