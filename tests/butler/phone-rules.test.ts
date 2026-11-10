import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import { phoneRules } from "../../src/phone/style";
import type { AdmittedMessage, RouteSnapshot } from "../../src/protocol";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

let route: RouteSnapshot;

beforeEach(async () => {
  await seedOwnerAddress("42");
  route = await channels().currentRoute();
});

afterEach(() => {
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
  setModelOverride(null);
  vi.restoreAllMocks();
});

function message(evt: {
  text: string | null;
  eventId: string;
}): AdmittedMessage {
  return {
    type: "message",
    channel: "telegram",
    chatId: "42",
    userId: "1",
    text: evt.text,
    eventId: evt.eventId,
    routeKey: route.routeKey,
  };
}

it("ends the system prompt with the conversational phone rules", async () => {
  const channel = fakeChannel();
  setChannelOverride("telegram", channel.adapter);
  let system = "";
  setModelOverride(
    scriptedModel([
      {
        text: "ok",
        observe: (context) => {
          system = getCurrentSystemPrompt(context.messages);
        },
      },
    ]),
  );

  await butler("phone-rules-system").handleMessage(
    message({ text: "你好", eventId: "phone-rules:system" }),
  );

  expect(system.endsWith(phoneRules("zh", { conversational: true }))).toBe(
    true,
  );
});
