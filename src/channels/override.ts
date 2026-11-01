import type { ChannelId } from "../protocol";
import type { ChannelAdapter } from "./types";

/**
 * Test-only channel overrides, mirroring `setModelOverride` in `llm/models`.
 * When set, the Butler and ChannelDO use this adapter instead of the real one.
 */
const channelOverrides = new Map<ChannelId, ChannelAdapter>();

export function setChannelOverride(
  channel: ChannelId,
  adapter: ChannelAdapter | null,
): void {
  if (adapter === null) {
    channelOverrides.delete(channel);
  } else {
    channelOverrides.set(channel, adapter);
  }
}

export function getChannelOverride(
  channel: ChannelId,
): ChannelAdapter | null {
  return channelOverrides.get(channel) ?? null;
}

/** Test-only iLink fetch replacement. */
let ilinkFetchOverride: typeof fetch | null = null;

export function setILinkFetchOverride(fetchImpl: typeof fetch | null): void {
  ilinkFetchOverride = fetchImpl;
}

export function getILinkFetchOverride(): typeof fetch | null {
  return ilinkFetchOverride;
}

/** Test-only shortened polling durations. */
export type PollTiming = { runMs: number; baseBackoffMs: number };

let pollTimingOverride: PollTiming | null = null;

export function setPollTimingOverride(timing: PollTiming | null): void {
  pollTimingOverride = timing;
}

export function getPollTimingOverride(): PollTiming | null {
  return pollTimingOverride;
}

/** Test-only credential JSON injection. */
let weChatCredentialsOverride: string | null = null;

export function setWeChatCredentialsOverride(json: string | null): void {
  weChatCredentialsOverride = json;
}

export function getWeChatCredentialsOverride(): string | null {
  return weChatCredentialsOverride;
}
