/**
 * Sanitized runtime channel events.
 *
 * A channel event is a single JSON log line with a fixed allowlist of fields.
 * It never carries message text, user ids, conversation ids, bot tokens, raw
 * provider errors or any other request context. Diagnostics reads these lines
 * from Workers Observability and correlates them with a script version.
 */

export const CHANNEL_EVENTS = [
  "poll_ok",
  "poll_expired",
  "poll_error",
  "send_ok",
  "send_error",
  "webhook_ok",
  "webhook_rejected",
] as const;

export type ChannelEventName = (typeof CHANNEL_EVENTS)[number];

export type ChannelName = "telegram" | "wechat";

/**
 * Fixed error codes. Callers must map a raw error to one of these values; an
 * unknown value is replaced with `unknown` instead of being logged verbatim.
 */
export const CHANNEL_ERROR_CODES = [
  "session_expired",
  "credential_invalid",
  "untrusted_origin",
  "rate_limited",
  "network_timeout",
  "network_error",
  "upstream_error",
  "api_error",
  "payload_invalid",
  "not_owner",
  "channel_not_configured",
  "unknown",
] as const;

export type ChannelErrorCode = (typeof CHANNEL_ERROR_CODES)[number];

/** The only keys a channel event may contain. Tests enforce this list. */
export const CHANNEL_EVENT_KEYS = [
  "deskwand",
  "v",
  "versionId",
  "channel",
  "event",
  "errorCode",
  "at",
] as const;

export type ChannelEventInput = {
  channel: ChannelName;
  event: ChannelEventName;
  errorCode?: string;
};

const EVENT_SET = new Set<string>(CHANNEL_EVENTS);
const ERROR_CODE_SET = new Set<string>(CHANNEL_ERROR_CODES);

function versionIdOf(env: Env): string {
  return env.CF_VERSION_METADATA?.id ?? "";
}

/**
 * Emits exactly one structured log line. The return value is the logged event
 * (already sanitized) so callers and tests can inspect it without re-parsing
 * the console output; production callers ignore it.
 */
export function emitChannelEvent(
  env: Env,
  input: ChannelEventInput,
): Record<string, string | number> {
  const channel =
    input.channel === "telegram" || input.channel === "wechat"
      ? input.channel
      : "unknown";
  const event = EVENT_SET.has(input.event) ? input.event : "unknown";

  const record: Record<string, string | number> = {
    deskwand: "channel_event",
    v: 1,
    versionId: versionIdOf(env),
    channel,
    event,
  };

  if (input.errorCode !== undefined) {
    record.errorCode = ERROR_CODE_SET.has(input.errorCode)
      ? input.errorCode
      : "unknown";
  }
  record.at = new Date().toISOString();

  console.log(JSON.stringify(record));
  return record;
}
