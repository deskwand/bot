import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAdminGateway, type AdminDeps } from "../../src/admin/admin-gateway";
import { createMemberAdminRoutes, MEMBERS_PATH } from "../../src/admin/member-routes";
import { MemberError } from "../../src/members/store";
import type { AdminInviteView } from "../../src/members/admin-view";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "test-admin-token";

type Fake = {
  members: Array<{
    memberId: string;
    label: string;
    role: "owner" | "member";
    status: "active" | "revoked";
    epoch: number;
    connectionStatus: "unbound" | "running" | "expired" | "paused";
  }>;
  invites: Array<{
    inviteId: string;
    label: string;
    kind: "new" | "rebind";
    memberId: string | null;
    expiresAt: number;
  }>;
  fail?: { code: string; revokedTarget?: boolean };
  state?: AdminInviteView;
};

function fakeChannel(model: Fake) {
  const throwIf = () => {
    if (model.fail) throw new MemberError(model.fail.code);
  };
  return {
    listMembers: async () => model.members,
    adminPendingInvites: async () => model.invites,
    adminInviteState: async (id: string) =>
      model.state === undefined
        ? { ok: false as const, status: 404 as const }
        : { ok: true as const, view: { ...model.state, inviteId: id } },
    createMemberInvite: async () => {
      throwIf();
      return {
        inviteId: "inv-new",
        expiresAt: Date.now() + 60_000,
        bindUrl: "http://localhost:8787/members/bind/#token",
      };
    },
    rebindMember: async () => {
      throwIf();
      return { inviteId: "inv-rebind", expiresAt: Date.now() + 60_000, bindUrl: "" };
    },
    cancelMemberInvite: async () => {
      throwIf();
    },
    revokeMember: async () => {
      throwIf();
    },
    adminSubmitInvitePin: async () => ({
      ok: false as const,
      status: 409 as const,
    }),
  };
}

const baseView: AdminInviteView = {
  inviteId: "inv-1",
  label: "小王",
  status: "pending",
  stage: "scan",
  expiresAt: Date.now() + 60_000,
  qrContent: "https://weixin.qq.com/qr/1",
};

function routes(model: Fake = { members: [], invites: [] }) {
  return createMemberAdminRoutes({
    channel: () => fakeChannel(model) as never,
  });
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://bot.example${path}`, init);
}

describe("member admin routes", () => {
  it("renames connectionStatus to connection and never sets a cache", async () => {
    const model: Fake = {
      members: [
        {
          memberId: "owner",
          label: "我",
          role: "owner",
          status: "active",
          epoch: 1,
          connectionStatus: "running",
        },
      ],
      invites: [],
    };
    const res = await routes(model).fetch(request(MEMBERS_PATH));
    expect(await res.json()).toEqual({
      users: [
        {
          memberId: "owner",
          label: "我",
          role: "owner",
          status: "active",
          connection: "running",
          inviteId: null,
        },
      ],
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("attaches a pending rebind invite to its member", async () => {
    const model: Fake = {
      members: [
        {
          memberId: "m1",
          label: "小王",
          role: "member",
          status: "active",
          epoch: 1,
          connectionStatus: "expired",
        },
      ],
      invites: [
        { inviteId: "inv-r", label: "小王", kind: "rebind", memberId: "m1", expiresAt: 1 },
      ],
    };
    const body = (await (await routes(model).fetch(request(MEMBERS_PATH))).json()) as {
      users: Array<{ inviteId: string | null }>;
    };
    expect(body.users[0]?.inviteId).toBe("inv-r");
  });

  it("lists both invite kinds in the pending block", async () => {
    const model: Fake = {
      members: [],
      invites: [
        { inviteId: "a", label: "小王", kind: "new", memberId: null, expiresAt: 9 },
        { inviteId: "b", label: "小李", kind: "rebind", memberId: "m1", expiresAt: 9 },
      ],
    };
    const body = (await (
      await routes(model).fetch(request(`${MEMBERS_PATH}/invites`))
    ).json()) as { invites: Array<{ inviteId: string; kind: string }> };
    expect(body.invites.map((invite) => invite.kind)).toEqual(["new", "rebind"]);
  });

  it("maps write failures onto fixed codes", async () => {
    const maintenance = await routes({
      members: [],
      invites: [],
      fail: { code: "MAINTENANCE_ACTIVE" },
    }).fetch(
      request(`${MEMBERS_PATH}/invites`, {
        method: "POST",
        body: JSON.stringify({ label: "小王" }),
      }),
    );
    expect(maintenance.status).toBe(409);
    expect(await maintenance.json()).toEqual({ code: "MAINTENANCE_ACTIVE" });

    const pending = await routes({
      members: [],
      invites: [],
      fail: { code: "INVITE_PENDING" },
    }).fetch(
      request(`${MEMBERS_PATH}/invites`, {
        method: "POST",
        body: JSON.stringify({ label: "小王" }),
      }),
    );
    expect(pending.status).toBe(409);
    expect(await pending.json()).toEqual({ code: "INVITE_PENDING" });
  });

  it("refuses the owner row and unknown labels before touching the runtime", async () => {
    const owner = await routes({ members: [], invites: [] }).fetch(
      request(`${MEMBERS_PATH}/owner`, { method: "DELETE" }),
    );
    expect(owner.status).toBe(409);
    expect(await owner.json()).toEqual({ code: "OWNER_IMMUTABLE" });

    const label = await routes({ members: [], invites: [] }).fetch(
      request(`${MEMBERS_PATH}/invites`, {
        method: "POST",
        body: JSON.stringify({ label: "   " }),
      }),
    );
    expect(label.status).toBe(400);
    expect(await label.json()).toEqual({ code: "INVALID_LABEL" });
  });

  it("closes an already expired invite instead of deleting it silently", async () => {
    const model: Fake = {
      members: [],
      invites: [],
      state: { ...baseView, stage: "expired" },
    };
    const res = await routes(model).fetch(
      request(`${MEMBERS_PATH}/invites/inv-1`, { method: "DELETE" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "INVITE_CLOSED" });
  });

  it("returns the invite state and never leaks the ticket", async () => {
    const res = await routes({ members: [], invites: [], state: baseView }).fetch(
      request(`${MEMBERS_PATH}/invites/inv-1`),
    );
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ stage: "scan", qrContent: baseView.qrContent });
    for (const forbidden of ["ticket", "authorization", "bot_token"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("requires the admin token at the gateway", async () => {
    const deps = {
      token: TOKEN,
      versionId: "version-test",
      butler: () => env.BUTLER.get(env.BUTLER.idFromName("members-gateway")),
      channel: () => env.CHANNELS.get(env.CHANNELS.idFromName("members-gateway")),
      task: (id: string) => env.TASK.get(env.TASK.idFromName(id)),
      bot: (id: string) => env.BOT.get(env.BOT.idFromName(id)),
      life: () => env.LIFE.get(env.LIFE.idFromName("members-gateway-life")),
      wallet: () => env.WALLET.get(env.WALLET.idFromName("global")),
      artifacts: env.ARTIFACTS,
      mcpAuth: () => env.MCP_AUTH.get(env.MCP_AUTH.idFromName("global")),
    } as unknown as AdminDeps;
    const gateway = createAdminGateway(deps);

    const unauthorized = await gateway.fetch(request(MEMBERS_PATH));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ code: "ADMIN_UNAUTHORIZED" });

    const authorized = await gateway.fetch(
      request(MEMBERS_PATH, { headers: { authorization: `Bearer ${TOKEN}` } }),
    );
    expect(authorized.status).toBe(200);
  });
});
