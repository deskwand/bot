import { env, runInDurableObject } from "cloudflare:test";
import { config } from "../../src/config";

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

/**
 * Records where `"notify"` resolves to, as ChannelDO does for an inbound
 * message. Butler tests that exercise task messages need this because those
 * messages no longer carry a chat id of their own.
 */
export async function seedNotifyAddress(
  conversationId = "42",
): Promise<void> {
  await runInDurableObject(channels(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         updated_at = excluded.updated_at`,
      config.notifyChannel,
      conversationId,
      Date.now(),
    );
  });
}
