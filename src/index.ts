import { createAdminGateway } from "./admin/admin-gateway";
import { liveWalletReads } from "./admin/wallet-routes";
import { probeExchange } from "./exchange/probe";
import { ChannelDO } from "./channels/channel-do";
import { createGateway } from "./gateway";
import { ownerLocale } from "./i18n";
import { lifeStub } from "./life/client";
import { walletStub } from "./wallet/wallet-do";

export { ButlerDO } from "./butler/butler-do";
export { TaskDO } from "./task/task-do";
export { BotDO } from "./bot/bot-do";
export { BotChatDO } from "./bot/bot-chat-do";
export { ChannelDO };
export { McpAuthDO } from "./mcp/mcp-auth-do";
export { LifeDO } from "./life/life-do";
export { WalletDO } from "./wallet/wallet-do";

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
    life: () => lifeStub(env),
    wallet: () => walletStub(env),
    artifacts: env.ARTIFACTS,
    mcpAuth: () => mcpAuth(env),
    locale: () => ownerLocale(env),
    probeExchange: (account) => probeExchange(env, account),
    walletReads: liveWalletReads(env),
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const gateway = createGateway({
      artifacts: env.ARTIFACTS,
      admin: admin(env),
      mcpAuth: () => mcpAuth(env),
      locale: () => ownerLocale(env),
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

    // Lost alarms are repaired on their own schedule; the sweep's own
    // throttle and its per-bot catch keep it from breaking the cron.
    try {
      await butler(env).healBots();
    } catch (error) {
      console.error("bot heal failed:", error);
    }

    // Same sweep idea for tasks: a Task DO that stopped responding cannot
    // report its own failure, so the cron probes the running ones.
    try {
      await butler(env).healTasks();
    } catch (error) {
      console.error("task heal failed:", error);
    }

    // The Butler is awake here anyway; this recovers turns whose wait was lost.
    try {
      await butler(env).healTurns();
    } catch (error) {
      console.error("turn heal failed:", error);
    }

    // A task that has been running a while gets one line, not a progress feed.
    try {
      await butler(env).healSlowTasks();
    } catch (error) {
      console.error("slow task reminder failed:", error);
    }
  },
} satisfies ExportedHandler<Env>;
