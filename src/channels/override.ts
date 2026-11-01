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
