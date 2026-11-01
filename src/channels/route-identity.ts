import type { ChannelId, RouteSnapshot } from "../protocol";

const ACTIVE_CHANNELS: readonly ChannelId[] = ["telegram", "wechat"];

/** Route key used while business traffic is disabled. */
export const DISABLED_ROUTE_KEY = "disabled";

/**
 * The only channel selection authority. A missing variable keeps the old
 * Telegram default; anything else than the two known channels disables
 * business traffic instead of silently falling back.
 */
export function parseActiveChannel(value: string | undefined): ChannelId | null {
  if (value === undefined) return "telegram";
  return ACTIVE_CHANNELS.includes(value as ChannelId)
    ? (value as ChannelId)
    : null;
}

/**
 * Deployment identity for message ownership. A deployed Worker always carries
 * the version binding; a local `wrangler dev` run has the binding without an
 * id, which is the only case that falls back to `dev`.
 */
export function versionIdOf(
  metadata: { id?: string } | undefined,
): string | null {
  if (metadata === undefined) return null;
  return metadata.id ? metadata.id : "dev";
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Deterministic ownership key for the current deployment, selection and target
 * account. Nothing is persisted: any redeploy changes the key, so a message
 * reference from an earlier deployment can never be reused — including an
 * A→B→A switch whose middle deployment never woke this object.
 */
export async function routeIdentity(input: {
  versionId: string;
  channel: ChannelId | null;
  targetIdentityHash: string;
}): Promise<RouteSnapshot> {
  if (input.channel === null) {
    return { channel: null, routeKey: DISABLED_ROUTE_KEY };
  }

  const routeKey = await sha256Hex(
    `channel-route/v1|${input.versionId}|${input.channel}|${input.targetIdentityHash}`,
  );
  return { channel: input.channel, routeKey };
}
