import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import type { PiOperationResult } from "agents/harness/pi";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotsRepo } from "../../src/butler/bots-repo";
import { botNoticeText } from "../../src/butler/owner-copy";
import { setChannelOverride } from "../../src/channels/override";
import { t } from "../../src/i18n";
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
  images?: AdmittedMessage["images"];
}): AdmittedMessage {
  return {
    type: "message",
    channel: "telegram",
    chatId: "42",
    userId: "1",
    text: evt.text,
    ...(evt.images === undefined ? {} : { images: evt.images }),
    eventId: evt.eventId,
    routeKey: route.routeKey,
  };
}

async function seedBot(
  stub: ReturnType<typeof butler>,
  id: string,
  name: string,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    new BotsRepo(state.storage.sql).insert({ id, name });
  });
}

describe("butler phone fit", () => {
  it("does not compress when the turn is not eligible for delivery", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let calls = 0;
    setModelOverride(
      scriptedModel([
        {
          text: "长".repeat(400),
          observe: () => {
            calls += 1;
          },
        },
        {
          text: "不该压缩",
          observe: () => {
            calls += 1;
          },
        },
      ]),
    );
    const stub = butler("phone-fit-ineligible");

    await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as {
        ensureAgent(): Promise<void>;
        turns(): import("../../src/butler/turn-store").TurnStore;
        deliverResult(
          operationId: string,
          result: PiOperationResult,
        ): Promise<void>;
        harness: {
          submit(
            input: string,
            options: { operationId: string },
          ): Promise<{ accepted: boolean }>;
          wait(operationId: string): Promise<PiOperationResult>;
        };
      };
      await target.ensureAgent();
      target.turns().insertIfAbsent({
        operationId: "phone-fit:ineligible",
        submittedAt: Date.now(),
      });
      // Another isolate is mid-send: this one must not redo the work.
      target.turns().delivering("phone-fit:ineligible", Date.now());
      await target.harness.submit("查一下", {
        operationId: "phone-fit:ineligible",
      });
      await target.deliverResult(
        "phone-fit:ineligible",
        await target.harness.wait("phone-fit:ineligible"),
      );
    });

    expect(calls).toBe(1);
  });
  it("fits an over-long butler answer", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([{ text: "长".repeat(400) }, { text: "短结论" }]),
    );

    await butler("phone-fit-long").handleMessage(
      message({ text: "查一下", eventId: "phone-fit:long" }),
    );

    expect(channel.sent.at(-1)?.text).toBe("短结论");
    expect(channel.artifacts).toHaveLength(1);
    expect(channel.artifacts[0]?.name).toBe(t("zh", "phone.originalName"));
    const stored = await env.ARTIFACTS.list({ prefix: "phone/" });
    expect(stored.objects).toHaveLength(1);
  });

  it("leaves a short butler answer untouched", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    let calls = 0;
    setModelOverride(
      scriptedModel([
        { text: "好的", observe: () => { calls += 1; } },
        { text: "不该压缩", observe: () => { calls += 1; } },
      ]),
    );

    await butler("phone-fit-short").handleMessage(
      message({ text: "查一下", eventId: "phone-fit:short" }),
    );

    expect(channel.sent.at(-1)?.text).toBe("好的");
    expect(calls).toBe(1);
    expect(channel.artifacts).toEqual([]);
  });

  it("fits a bot notify message", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(scriptedModel([{ text: "短结论" }]));
    const stub = butler("phone-fit-bot");
    await seedBot(stub, "b1", "盯盘");

    const delivered = await stub.notifyFromBot("b1", "长".repeat(400));

    expect(delivered).toBe(true);
    expect(channel.sent.at(-1)?.text).toBe(
      botNoticeText("zh", "盯盘", "短结论"),
    );
  });

  it("still sends when the task model is unavailable", async () => {
    const channel = fakeChannel();
    setChannelOverride("telegram", channel.adapter);
    setModelOverride(
      scriptedModel([{ text: "长".repeat(400) }, { error: "quota" }]),
    );

    await butler("phone-fit-unavailable").handleMessage(
      message({ text: "查一下", eventId: "phone-fit:unavailable" }),
    );

    const answer = channel.sent.at(-1)?.text ?? "";
    expect([...answer].length).toBeLessThanOrEqual(300);
    expect(answer.endsWith(t("zh", "phone.truncatedSuffix"))).toBe(true);
    expect(channel.artifacts).toHaveLength(1);
  });

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

    await butler("phone-fit-system").handleMessage(
      message({ text: "你好", eventId: "phone-fit:system" }),
    );

    expect(system.endsWith(phoneRules("zh", { conversational: true }))).toBe(
      true,
    );
  });
});
