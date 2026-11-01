import type { ChannelAdapter } from "./types";

/**
 * Test-only channel override, mirroring `setModelOverride` in `llm/models`.
 * When set, the Butler sends through this adapter instead of Telegram.
 */
let channelOverride: ChannelAdapter | null = null;

export function setChannelOverride(adapter: ChannelAdapter | null): void {
  channelOverride = adapter;
}

export function getChannelOverride(): ChannelAdapter | null {
  return channelOverride;
}
