import { ChannelDO } from "./channels/channel-do";
import { createGateway } from "./gateway";

export { ButlerDO } from "./butler/butler-do";
export { TaskDO } from "./task/task-do";
export { ChannelDO };

function channels(env: Env): DurableObjectStub<ChannelDO> {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const gateway = createGateway({
      channels: () => channels(env),
      artifacts: env.ARTIFACTS,
    });

    return gateway.fetch(req);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await channels(env).ensurePolling();
    } catch (error) {
      console.error("channel polling failed:", error);
    }
  },
} satisfies ExportedHandler<Env>;
