/**
 * The inbound file inbox: attachments that arrive with a message are stored
 * under `inbox/<eventId>/<name>` and the task only ever sees their references.
 */
import { artifactKeySegments, sanitizeFilename } from "../artifact";
import type { ArtifactStore } from "../artifact-store";
import type { InboundFile } from "../protocol";

export const INBOX_PREFIX = "inbox/";

const INVALID_EVENT_ID_CHARS = /[/\\\x00-\x1f\x7f]/g;

export function inboxKey(eventId: string, name: string): string {
  const safeEventId = eventId.replace(INVALID_EVENT_ID_CHARS, "_");
  return `${INBOX_PREFIX}${safeEventId}/${sanitizeFilename(name)}`;
}

/** A key the backup listing skips and `spawn_task` accepts as an attachment. */
export function isInboxKey(key: string): boolean {
  return key.startsWith(INBOX_PREFIX) && artifactKeySegments(key) !== null;
}

export type StoreInboundFile = (
  eventId: string,
  name: string,
  bytes: Uint8Array,
  mimeType: string,
) => Promise<InboundFile>;

export function inboxStore(bucket: ArtifactStore): StoreInboundFile {
  return async (eventId, name, bytes, mimeType) => {
    const fileName = sanitizeFilename(name);
    const key = inboxKey(eventId, fileName);
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: mimeType },
    });
    return {
      name: fileName,
      key,
      mimeType,
      size: bytes.byteLength,
    };
  };
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** The model-facing line that names an inbound attachment and its inbox key. */
export function attachmentLine(file: InboundFile): string {
  return `[附件] ${file.name} · ${file.mimeType} · ${formatAttachmentSize(file.size)} · key: ${file.key}`; // i18n-ignore: model-facing
}
