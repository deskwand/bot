import { describe, expect, it } from "vitest";
import { createChannelAdminRoutes, CHANNELS_PATH } from "../../src/admin/channel-routes";
import { MemberError } from "../../src/members/store";

type Fake = {
  channels: Array<{
    channelId: string;
    label: string;
    account: string | null;
    state: string;
    lastErrorCode: string | null;
  }>;
  fail?: string;
};

function routes(model: Fake = { channels: [] }) {
  const fail = () => {
    if (model.fail) throw new MemberError(model.fail);
  };
  return createChannelAdminRoutes({
    channel: () =>
      ({
        adminChannels: async () => model.channels,
        createMemberInvite: async () => {
          fail();
          return { inviteId: "inv-1", expiresAt: 1, bindUrl: "http://x/members/bind/#t" };
        },
        adminInviteState: async (id: string) => ({
          ok: true,
          view: { inviteId: id, label: "chan", status: "pending", stage: "scan" },
        }),
        adminSubmitInvitePin: async () => ({ ok: false, status: 409 }),
        rebindMember: async () => {
          fail();
          return { inviteId: "inv-r", expiresAt: 1, bindUrl: "" };
        },
        restartChannel: async () => {
          fail();
        },
        removeChannel: async () => {
          fail();
        },
        listMembers: async () => [],
        adminPendingInvites: async () => [],
        cancelMemberInvite: async () => {},
        revokeMember: async () => {},
      }) as never,
  });
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://bot.example${path}`, init);
}

describe("channel routes", () => {
  it("lists channels in the new shape", async () => {
    const res = await routes({
      channels: [
        {
          channelId: "c1",
          label: "小宝",
          account: "e8d1@im.bot",
          state: "needs_reset",
          lastErrorCode: "SEND_EXHAUSTED",
        },
      ],
    }).fetch(req(CHANNELS_PATH));
    expect(await res.json()).toEqual({
      channels: [
        {
          channelId: "c1",
          label: "小宝",
          account: "e8d1@im.bot",
          state: "needs_reset",
          lastErrorCode: "SEND_EXHAUSTED",
        },
      ],
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("restarts and removes through the new paths", async () => {
    const restart = await routes().fetch(
      req(`${CHANNELS_PATH}/c1/restart`, { method: "POST" }),
    );
    expect(restart.status).toBe(204);

    const remove = await routes().fetch(req(`${CHANNELS_PATH}/c1`, { method: "DELETE" }));
    expect(remove.status).toBe(204);
  });

  it("maps a refused restart (expired) onto REBIND_REQUIRED", async () => {
    const res = await routes({ channels: [], fail: "REBIND_REQUIRED" }).fetch(
      req(`${CHANNELS_PATH}/c1/restart`, { method: "POST" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "REBIND_REQUIRED" });
  });

  it("refuses to remove the first channel", async () => {
    const res = await routes({ channels: [], fail: "OWNER_IMMUTABLE" }).fetch(
      req(`${CHANNELS_PATH}/owner`, { method: "DELETE" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "CHANNEL_IMMUTABLE" });
  });

  it("lists pending bindings so a wizard can resume", async () => {
    const res = await routes().fetch(req(`${CHANNELS_PATH}/bindings`));
    expect(await res.json()).toEqual({ bindings: [] });
  });

  it("cancels a pending binding", async () => {
    const res = await routes().fetch(
      req(`${CHANNELS_PATH}/bindings/inv-1`, { method: "DELETE" }),
    );
    expect(res.status).toBe(204);
  });

  it("keeps the old path alive with a deprecation header", async () => {
    const res = await routes().fetch(req("/admin/members"));
    expect(res.status).toBe(200);
    expect(res.headers.get("deprecation")).toBe("true");
  });
});
