import type { Principal } from "../members/principal";
import type { TextAction } from "./text-action";
import type { Resolution } from "../butler/text-resolution";
import type { AdmittedMessage, ChannelId } from "../protocol";
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

/**
 * The narrow Butler contract a member dispatch depends on. Task 5 owns the
 * Butler side: the runtime only requires `initializeMember` before
 * `handleMessage`, and a Butler build without it makes the dispatch fail
 * closed instead of falling back to the owner.
 */
export type MemberButlerRpc = {
  initializeMember(actor: Principal): Promise<unknown>;
  handleMessage(message: AdmittedMessage): Promise<unknown>;
  resolveTextAction?(
    action: TextAction,
    actor?: Principal,
  ): Promise<Resolution>;
  hasTask?(taskId: string, actor?: Principal): Promise<boolean>;
};

/**
 * Test-only member Butler replacement. It exists so tests can capture the
 * trusted dispatch (actor, connection, route key) before Task 5 lands; it is
 * not a permission surface and the runtime keeps every admission check.
 */
let memberButlerOverride: MemberButlerRpc | null = null;

export function setMemberButlerOverride(rpc: MemberButlerRpc | null): void {
  memberButlerOverride = rpc;
}

export function getMemberButlerOverride(): MemberButlerRpc | null {
  return memberButlerOverride;
}

/** Test-only iLink fetch replacement. */
let ilinkFetchOverride: typeof fetch | null = null;

export function setILinkFetchOverride(fetchImpl: typeof fetch | null): void {
  ilinkFetchOverride = fetchImpl;
}

export function getILinkFetchOverride(): typeof fetch | null {
  return ilinkFetchOverride;
}

/** Test-only Telegram Bot API fetch replacement. */
let telegramFetchOverride: typeof fetch | null = null;

export function setTelegramFetchOverride(fetchImpl: typeof fetch | null): void {
  telegramFetchOverride = fetchImpl;
}

export function getTelegramFetchOverride(): typeof fetch | null {
  return telegramFetchOverride;
}

/**
 * Test-only shortened polling durations.
 *
 * `manualStart` makes `ensurePolling` initialise state without scheduling a
 * zero-delay poll. Tests that drive `pollWeChat` themselves must set it: the
 * scheduled chain would otherwise start between two test RPCs and race with the
 * fetch override installed for the manual poll.
 */
export type PollTiming = {
  runMs: number;
  baseBackoffMs: number;
  manualStart?: boolean;
};

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
