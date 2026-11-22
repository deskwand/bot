import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { DirectoryUnavailable } from "../../src/members/client";
import { MEMBER_ACCESS_DENIED, MemberError } from "../../src/members/store";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function memberButler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(`member:${name}`));
}

describe("member alarm classification", () => {
  it("re-arms after a transient directory failure", async () => {
    const butler = memberButler("alarm-transient");
    const alarm = await runInDurableObject(butler, async (instance, state) => {
      vi.spyOn(instance, "ensurePrincipal").mockRejectedValue(
        new DirectoryUnavailable(),
      );
      await instance.alarm();
      return state.storage.getAlarm();
    });
    // A blip must not end the chain: the next alarm is scheduled.
    expect(alarm).not.toBeNull();
  });

  it("stays stopped after a terminal denial", async () => {
    const butler = memberButler("alarm-terminal");
    const alarm = await runInDurableObject(butler, async (instance, state) => {
      // A denial crosses the DO boundary as a plain error carrying name+code;
      // `instanceof MemberError` is false there, which is why classification
      // must use the name and the fixed code.
      const denial = new Error(MEMBER_ACCESS_DENIED);
      denial.name = "MemberError";
      (denial as unknown as { code: string }).code = MEMBER_ACCESS_DENIED;
      vi.spyOn(instance, "ensurePrincipal").mockRejectedValue(denial);
      await instance.alarm();
      return state.storage.getAlarm();
    });
    expect(alarm).toBeNull();
  });
});
