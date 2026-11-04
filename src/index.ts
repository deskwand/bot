import { createAdminGateway } from "./admin/admin-gateway";
import { ChannelDO } from "./channels/channel-do";
import { createGateway } from "./gateway";

export { ButlerDO } from "./butler/butler-do";
export { TaskDO } from "./task/task-do";
export { BotDO } from "./bot/bot-do";
export { ChannelDO };
export { McpAuthDO } from "./mcp/mcp-auth-do";

function channels(env: Env): DurableObjectStub<ChannelDO> {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

function butler(env: Env) {
  return env.BUTLER.get(env.BUTLER.idFromName("owner"));
}

function mcpAuth(env: Env) {
  return env.MCP_AUTH.get(env.MCP_AUTH.idFromName("global"));
}

function admin(env: Env) {
  return createAdminGateway({
    token: env.ADMIN_TOKEN,
    versionId: env.CF_VERSION_METADATA.id,
    butler: () => butler(env),
    channel: () => channels(env),
    task: (id) => env.TASK.get(env.TASK.idFromName(id)),
    bot: (id) => env.BOT.get(env.BOT.idFromName(id)),
    artifacts: env.ARTIFACTS,
    mcpAuth: () => mcpAuth(env),
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const gateway = createGateway({
      artifacts: env.ARTIFACTS,
      admin: admin(env),
      mcpAuth: () => mcpAuth(env),
    });

    return gateway.fetch(req);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (await butler(env).maintenanceActive()) return;

    const hub = channels(env);
    try {
      await hub.ensurePolling();
    } catch (error) {
      console.error("channel polling failed:", error);
    }

    // ChannelDO never calls back into the Butler: the Cron reconciles after
    // channel keepalive, using the route this instance now executes.
    try {
      const route = await hub.currentRoute();
      if (route.channel !== null) {
        await butler(env).reconcileChannel(route.routeKey);
      }
    } catch (error) {
      console.error("butler approval reconcile failed:", error);
    }
  },
} satisfies ExportedHandler<Env>;
