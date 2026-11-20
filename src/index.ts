import { createAdminGateway } from "./admin/admin-gateway";
import {
  codexStatus,
  disconnectCodex,
  pollCodexLogin,
  startCodexLogin,
  CODEX_PROVIDER_ID,
} from "./llm/codex";
import { browserClient } from "./sandbox/browser-http";
import { sandboxFetch } from "./sandbox/install";
import { liveWalletReads } from "./admin/wallet-routes";
import { artifactStore } from "./artifact-store";
import { ingestSnapshot } from "./exchange/ingest";
import { probeExchange } from "./exchange/probe";
import { ChannelDO } from "./channels/channel-do";
import { createGateway } from "./gateway";
import { createMemberBindRoutes } from "./members/bind-routes";
import { bindPageHtml, renderQrSvg } from "./members/bind-page";
import { en, ownerLocale, zh } from "./i18n";
import { butlerName } from "./members/principal";
import { lifeStub } from "./life/client";
import { walletConfigured, walletStub } from "./wallet/wallet-do";

export { ButlerDO } from "./butler/butler-do";
export { TaskDO } from "./task/task-do";
export { BotDO } from "./bot/bot-do";
export { BotChatDO } from "./bot/bot-chat-do";
export { ChannelDO };
export { McpAuthDO } from "./mcp/mcp-auth-do";
export { LifeDO } from "./life/life-do";
export { WalletDO } from "./wallet/wallet-do";
export { ExchangeDO } from "./exchange/exchange-do";

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
    // Backup and admin routes address the owner by default and a member by id.
    butler: (id?: string) =>
      id === undefined || id === "owner"
        ? butler(env)
        : env.BUTLER.get(env.BUTLER.idFromName(`member:${id}`)),
    channel: () => channels(env),
    task: (id) => env.TASK.get(env.TASK.idFromName(id)),
    bot: (id) => env.BOT.get(env.BOT.idFromName(id)),
    life: () => lifeStub(env),
    wallet: () => walletStub(env),
    // Null when the deployment has no sandbox; the takeover page says so.
    browser: browserClient(env, sandboxFetch(env) ?? fetch),
    artifacts: artifactStore(env),
    mcpAuth: () => mcpAuth(env),
    locale: () => ownerLocale(env),
    probeExchange: (account) => probeExchange(env, account),
    ingestExchangeSnapshot: (body) => ingestSnapshot(env, body),
    walletReads: liveWalletReads(env),
    modelAuth: {
      status: async () => [
        { id: CODEX_PROVIDER_ID, ...(await codexStatus(env)) },
      ],
      start: () => startCodexLogin(),
      poll: (device) => pollCodexLogin(device, env),
      disconnect: () => disconnectCodex(env),
    },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const copy = (ownerLocale(env) === "en" ? en : zh).member.bindPage;
    const gateway = createGateway({
      bind: createMemberBindRoutes({
        channel: channels(env) as unknown as Parameters<
          typeof createMemberBindRoutes
        >[0]["channel"],
        publicBaseUrl: env.PUBLIC_BASE_URL,
        title: copy.title,
        page: bindPageHtml(copy, env.PUBLIC_BASE_URL),
        renderQr: (text) => renderQrSvg(text, copy.qrLabel),
      }),
      artifacts: artifactStore(env),
      admin: admin(env),
      mcpAuth: () => mcpAuth(env),
      locale: () => ownerLocale(env),
    });

    return gateway.fetch(req);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (await butler(env).maintenanceActive()) return;

    // The wallet's hourly alarm is the only sampler; repair it if it was lost.
    // A sixteenth-of-an-hour slot keeps the probe from running every minute.
    if (
      new Date(controller.scheduledTime).getUTCMinutes() % 15 === 0 &&
      walletConfigured(env)
    ) {
      try {
        await walletStub(env).ensureAlarm();
      } catch (error) {
        console.warn(
          "wallet alarm ensure failed:",
          error instanceof Error ? error.constructor.name : "Error",
        );
      }
      try {
        await butler(env).ensureEarner();
      } catch (error) {
        console.warn(
          "earner ensure failed:",
          error instanceof Error ? error.constructor.name : "Error",
        );
      }
    }

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

    // Every member Butler gets the same repair sweep, bounded per member so one
    // broken member cannot stop the rest or the owner's cron.
    try {
      const ids = await hub.memberIds();
      for (const memberId of ids) {
        const member = env.BUTLER.get(env.BUTLER.idFromName(butlerName(memberId)));
        try {
          const actor = await hub.memberPrincipal(memberId);
          if (actor === null || actor.role !== "member") continue;
          // A revoked member no longer owns a route or a sweepable session.
          if ((await hub.assertMemberActive(actor).then(() => true, () => false)) === false) {
            continue;
          }
          await member.reconcileChannel(
            (await hub.routeForMember(actor)).routeKey,
          );
          await member.healTurns();
          await member.healTasks();
          await member.healSlowTasks();
        } catch (error) {
          console.error("member heal failed:", error);
        }
      }
    } catch (error) {
      console.error("member sweep failed:", error);
    }
  },
} satisfies ExportedHandler<Env>;
