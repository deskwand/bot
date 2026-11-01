import { env, runInDurableObject } from "cloudflare:test";
import { parseActiveChannel } from "../../src/channels/route-identity";
import type { ChannelMessageRef } from "../../src/protocol";

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

/**
 * Records the selected channel's conversation, as ChannelDO resolves it for
 * outbound messages.
 */
export async function seedOwnerAddress(
  conversationId = "42",
): Promise<void> {
  const channel = parseActiveChannel(
    (env as unknown as Env).ACTIVE_CHANNEL,
  );
  if (channel === null) throw new Error("test env has no active channel");

  await runInDurableObject(channels(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         updated_at = excluded.updated_at`,
      channel,
      conversationId,
      Date.now(),
    );
  });
}

/**
 * A message reference owned by the current selection and deployment, for
 * seeding rows that an older release wrote as a bare message id.
 */
export async function currentChannelRef(
  messageId: string | null = null,
  conversationId = "42",
): Promise<ChannelMessageRef> {
  const route = await channels().currentRoute();
  if (route.channel === null) throw new Error("no active channel");
  return {
    channel: route.channel,
    conversationId,
    routeKey: route.routeKey,
    messageId,
  };
}
