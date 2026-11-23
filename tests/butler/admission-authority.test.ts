import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

type Admission = {
  admissionHolds(evt: {
    channel: string;
    routeKey: string;
    connectionRef?: { memberId: string; connectionId: string; generation: number };
    event: unknown;
  }): Promise<boolean>;
  channels(): {
    isAdmissionCurrent(channel: string, routeKey: string): Promise<boolean>;
    isMemberAdmissionCurrent(
      actor: unknown,
      channel: string,
      ref: unknown,
      routeKey: string,
    ): Promise<boolean>;
  };
};

describe("admission authority", () => {
  it("checks the connection that admitted the message, not the object's shape", async () => {
    // The owner's butler is still an owner object, but its input now arrives
    // through the first channel's connection. Judging that input by the
    // deployment route dropped every message, silently.
    const butler = env.BUTLER.get(env.BUTLER.idFromName("owner"));
    const held = await runInDurableObject(butler, async (instance) => {
      const api = instance as unknown as Admission & { channels: unknown };
      // The stub is an RPC proxy: overriding its methods does not take. Replace
      // the accessor instead, which is also how the other butler tests stub it.
      api.channels = () => ({
        isAdmissionCurrent: async () => false,
        isMemberAdmissionCurrent: async () => true,
      });
      return await api.admissionHolds({
        channel: "wechat",
        routeKey: "conn-route-key",
        connectionRef: {
          memberId: "owner",
          connectionId: "wechat-owner",
          generation: 1,
        },
        event: {},
      });
    });
    expect(held).toBe(true);
  });
});
