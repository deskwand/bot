import { createTelegramAdapter } from "./channels/telegram";
import { config, isOwner } from "./config";
import { createGateway } from "./gateway";

export { TestHarnessDO } from "./testing/test-harness-do";
export { ButlerDO } from "./butler/butler-do";
export { TaskDO } from "./task/task-do";

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const gateway = createGateway({
      adapter: createTelegramAdapter({
        token: env.TELEGRAM_BOT_TOKEN,
        webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
      }),
      isOwner: (userId) => isOwner(config, userId),
      butler: () => {
        const stub = env.BUTLER.get(env.BUTLER.idFromName("owner"));
        // `Agent` reserves `onMessage` for WebSocket messages and does not
        // expose it over RPC; the Butler's RPC entry is `handleMessage`.
        return { onMessage: (evt) => stub.handleMessage(evt) };
      },
      task: (taskId) => env.TASK.get(env.TASK.idFromName(taskId)),
      artifacts: env.ARTIFACTS,
    });

    return gateway.fetch(req, ctx);
  },
} satisfies ExportedHandler<Env>;
