import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  LEGACY_INBOX_MIGRATION,
  ensureMigrationTable,
} from "../../src/members/artifact-access";
import { MemberError, MemberStore } from "../../src/members/store";
import { ownerPrincipal } from "../../src/members/principal";
import { setILinkFetchOverride } from "../../src/channels/override";
import type { AdminInviteView } from "../../src/members/admin-view";
import { memberBinding } from "../helpers/members";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

type AdminRpc = {
  createMemberInvite(actor: unknown, label: string): Promise<{ inviteId: string }>;
  cancelMemberInvite(actor: unknown, inviteId: string): Promise<void>;
  adminPendingInvites(): Promise<
    Array<{ inviteId: string; label: string; kind: string; memberId: string | null }>
  >;
  adminInviteState(
    id: string,
  ): Promise<{ ok: boolean; view?: AdminInviteView; status?: number }>;
  adminSubmitInvitePin(
    id: string,
    pin: string,
  ): Promise<{ ok: boolean; status?: number; view?: AdminInviteView }>;
  acquireMaintenance(op: string, opId: string): Promise<unknown>;
  releaseMaintenance(opId: string): Promise<void>;
  setMemberTeen(
    actor: unknown,
    memberId: string,
    teen: boolean,
  ): Promise<void>;
  listMembers(actor: unknown): Promise<Array<{ memberId: string; teen: boolean }>>;
};

function channel(name: string) {
  return env.CHANNELS.get(
    env.CHANNELS.idFromName(`${name}-${crypto.randomUUID()}`),
  );
}

function settle(sql: SqlStorage): void {
  ensureMigrationTable(sql);
  sql.exec(
    `INSERT INTO member_migrations (name, cursor, done, updated_at)
     VALUES (?, NULL, 1, 1)
     ON CONFLICT(name) DO UPDATE SET done = 1`,
    LEGACY_INBOX_MIGRATION,
  );
}

function asAdmin(instance: unknown): AdminRpc {
  return instance as AdminRpc;
}

describe("member admin RPC", () => {
  it("lists both invite kinds and hides closed ones", async () => {
    const hub = channel("admin-pending");
    const result = await runInDurableObject(hub, async (instance, state) => {
      settle(state.storage.sql);
      const api = asAdmin(instance);
      const first = await api.createMemberInvite(ownerPrincipal(), "小王");
      const second = await api.createMemberInvite(ownerPrincipal(), "小李");
      await api.cancelMemberInvite(ownerPrincipal(), second.inviteId);
      return { pending: await api.adminPendingInvites(), first };
    });
    expect(result.pending.map((invite) => invite.inviteId)).toEqual([
      result.first.inviteId,
    ]);
    expect(result.pending[0]).toMatchObject({ kind: "new", memberId: null });
  });

  it("reads a fresh invite as starting and an unknown one as 404", async () => {
    const hub = channel("admin-state");
    const result = await runInDurableObject(hub, async (instance, state) => {
      settle(state.storage.sql);
      const api = asAdmin(instance);
      const link = await api.createMemberInvite(ownerPrincipal(), "小王");
      return {
        fresh: await api.adminInviteState(link.inviteId),
        missing: await api.adminInviteState("no-such-invite"),
      };
    });
    expect(result.fresh.ok).toBe(true);
    expect(result.fresh.view?.stage).toBe("starting");
    expect(result.fresh.view).not.toHaveProperty("qrContent");
    expect(result.missing).toEqual({ ok: false, status: 404 });
  });

  it("refuses a second pending invite for the same label", async () => {
    const hub = channel("admin-duplicate");
    const error = await runInDurableObject(hub, async (instance, state) => {
      settle(state.storage.sql);
      const api = asAdmin(instance);
      await api.createMemberInvite(ownerPrincipal(), "小王");
      return await api
        .createMemberInvite(ownerPrincipal(), "小王")
        .catch((caught: unknown) => caught);
    });
    expect(error).toBeInstanceOf(MemberError);
    expect((error as MemberError).code).toBe("INVITE_PENDING");
  });

  it("rejects a malformed PIN before touching the machine", async () => {
    const hub = channel("admin-pin-format");
    const result = await runInDurableObject(hub, async (instance, state) => {
      settle(state.storage.sql);
      const api = asAdmin(instance);
      const link = await api.createMemberInvite(ownerPrincipal(), "小王");
      return {
        bad: await api.adminSubmitInvitePin(link.inviteId, "12"),
        missing: await api.adminSubmitInvitePin("nope", "123456"),
        wrongStage: await api.adminSubmitInvitePin(link.inviteId, "123456"),
      };
    });
    expect(result.bad).toEqual({ ok: false, status: 400 });
    expect(result.missing).toEqual({ ok: false, status: 404 });
    expect(result.wrongStage).toEqual({ ok: false, status: 409 });
  });

  it("refuses writes while a maintenance lease is held", async () => {
    const hub = channel("admin-maintenance");
    const error = await runInDurableObject(hub, async (instance, state) => {
      settle(state.storage.sql);
      const api = asAdmin(instance);
      const lease = await api.acquireMaintenance("backup", "op-1");
      expect(lease).not.toBe("busy");
      try {
        return await api
          .createMemberInvite(ownerPrincipal(), "小王")
          .catch((caught: unknown) => caught);
      } finally {
        await api.releaseMaintenance("op-1");
      }
    });
    expect(error).toBeInstanceOf(MemberError);
    expect((error as MemberError).code).toBe("MAINTENANCE_ACTIVE");
  });
});

describe("member admin safety rails", () => {
  it("no longer registers the chat management tools", async () => {
    const butler = env.BUTLER.get(
      env.BUTLER.idFromName(`butler-tools-${crypto.randomUUID()}`),
    );
    const names = await runInDurableObject(butler, (instance) =>
      (
        instance as unknown as {
          registry: {
            snapshot(): { tools(): { tool: { name: string } }[] };
          };
        }
      )
        .registry.snapshot()
        .tools()
        .map(({ tool }) => tool.name),
    );
    expect(names).toContain("spawn_task");
    for (const gone of [
      "invite_member",
      "rebind_member",
      "cancel_member_invite",
      "list_members",
      "revoke_member",
    ]) {
      expect(names).not.toContain(gone);
    }
  });

  it("refuses a PIN while a maintenance lease is held", async () => {
    const hub = channel("admin-pin-maintenance");
    const error = await runInDurableObject(hub, async (instance, state) => {
      settle(state.storage.sql);
      const api = asAdmin(instance);
      const link = await api.createMemberInvite(ownerPrincipal(), "小王");
      await api.acquireMaintenance("restore", "op-pin");
      try {
        return await api
          .adminSubmitInvitePin(link.inviteId, "123456")
          .catch((caught: unknown) => caught);
      } finally {
        await api.releaseMaintenance("op-pin");
      }
    });
    expect(error).toBeInstanceOf(MemberError);
    expect((error as MemberError).code).toBe("MAINTENANCE_ACTIVE");
  });
});

/** One fake iLink that reaches the PIN stage and stays there. */
function pinStageFetch(): { restore(): void } {
  const expire = Math.floor(Date.now() / 1000) + 180;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      });
    if (url.includes("step=get_auth_url")) {
      return body({
        ret: 0,
        data: {
          auth_url: "https://liteapp.weixin.qq.com/q/pin",
          bot_spam_ticket: "ticket",
          expire_time: expire,
        },
      });
    }
    if (url.includes("step=query_auth_result")) {
      return body({ ret: 0, data: { auth_status: 1 } });
    }
    if (url.includes("get_bot_qrcode")) {
      return body({ qrcode: "qr-1", qrcode_img_content: "https://weixin.qq.com/q/pin" });
    }
    if (url.includes("get_qrcode_status")) {
      return body({ status: "need_verifycode" });
    }
    return body({ ret: 0 });
  }) as typeof fetch;
  setILinkFetchOverride(fetchImpl);
  return { restore: () => setILinkFetchOverride(null) };
}

describe("PIN budget and scheduler recovery", () => {
  it("shares one five-attempt budget between the page and the admin path", async () => {
    const fake = pinStageFetch();
    try {
      const hub = channel("admin-pin-budget");
      const result = await runInDurableObject(hub, async (instance, state) => {
        settle(state.storage.sql);
        const api = asAdmin(instance);
        const link = await api.createMemberInvite(ownerPrincipal(), "小王");
        // Two steps: real-name approval, then the scan poll that asks for a PIN.
        await (instance as unknown as {
          pollMemberLogin(p: { inviteId: string; generation: number }): Promise<void>;
        }).pollMemberLogin({ inviteId: link.inviteId, generation: 1 });
        await (instance as unknown as {
          pollMemberLogin(p: { inviteId: string; generation: number }): Promise<void>;
        }).pollMemberLogin({ inviteId: link.inviteId, generation: 1 });
        const stage = (await api.adminInviteState(link.inviteId)).view?.stage;
        const replies = [];
        for (let attempt = 0; attempt < 6; attempt += 1) {
          replies.push(await api.adminSubmitInvitePin(link.inviteId, "123456"));
        }
        return { stage, replies };
      });
      expect(result.stage).toBe("pin");
      expect(result.replies.slice(0, 5).map((reply) => reply.ok)).toEqual([
        true,
        true,
        true,
        true,
        true,
      ]);
      expect(result.replies[5]).toEqual({ ok: false, status: 429 });
    } finally {
      fake.restore();
    }
  }, 30_000);

  it("keeps the invite alive across a maintenance window", async () => {
    const fake = pinStageFetch();
    try {
      const hub = channel("admin-lease-resume");
      const result = await runInDurableObject(hub, async (instance, state) => {
        settle(state.storage.sql);
        const api = asAdmin(instance);
        const link = await api.createMemberInvite(ownerPrincipal(), "小王");
        await api.acquireMaintenance("backup", "op-lease");
        try {
          // Under the lease this must not throw and must not advance.
          await (instance as unknown as {
            pollMemberLogin(p: { inviteId: string; generation: number }): Promise<void>;
          }).pollMemberLogin({ inviteId: link.inviteId, generation: 1 });
          const held = (await api.adminInviteState(link.inviteId)).view?.stage;
          return { held, inviteId: link.inviteId };
        } finally {
          await api.releaseMaintenance("op-lease");
        }
      });
      const resumed = await runInDurableObject(hub, async (instance) => {
        const api = asAdmin(instance);
        await (instance as unknown as {
          pollMemberLogin(p: { inviteId: string; generation: number }): Promise<void>;
        }).pollMemberLogin({ inviteId: result.inviteId, generation: 1 });
        return (await api.adminInviteState(result.inviteId)).view?.stage;
      });
      // The lease held the invite at starting; one step after release runs the
      // real-name approval and the first QR issuance in the same poll.
      expect(result.held).toBe("starting");
      expect(resumed).toBe("scan");
    } finally {
      fake.restore();
    }
  }, 30_000);
});

describe("member admin minor flag", () => {
  it("flips the flag on a live member only", async () => {
    const hub = channel("admin-teen");
    const result = await runInDurableObject(hub, async (instance, state) => {
      settle(state.storage.sql);
      const store = new MemberStore(state.storage.sql);
      store.ensureOwner();
      const invite = store.createInvite("小王");
      const member = store.completeInvite(invite.inviteId, memberBinding);

      const api = asAdmin(instance);
      await api.setMemberTeen(ownerPrincipal(), member.memberId, true);
      const listed = await api.listMembers(ownerPrincipal());
      const ownerDenied = await api
        .setMemberTeen(ownerPrincipal(), "owner", true)
        .catch((caught: unknown) => caught);
      const unknownDenied = await api
        .setMemberTeen(ownerPrincipal(), "mdeadbeef", true)
        .catch((caught: unknown) => caught);
      return { member, listed, ownerDenied, unknownDenied };
    });

    expect(
      result.listed.find((entry) => entry.memberId === result.member.memberId)
        ?.teen,
    ).toBe(true);
    expect((result.ownerDenied as MemberError).code).toBe("OWNER_IMMUTABLE");
    expect((result.unknownDenied as MemberError).code).toBe(
      "MEMBER_ACCESS_DENIED",
    );
  });

  it("refuses the flag while a maintenance lease is held", async () => {
    const hub = channel("admin-teen-maintenance");
    const error = await runInDurableObject(hub, async (instance, state) => {
      settle(state.storage.sql);
      const store = new MemberStore(state.storage.sql);
      store.ensureOwner();
      const invite = store.createInvite("小王");
      const member = store.completeInvite(invite.inviteId, memberBinding);

      const api = asAdmin(instance);
      await api.acquireMaintenance("backup", "op-teen");
      try {
        return await api
          .setMemberTeen(ownerPrincipal(), member.memberId, true)
          .catch((caught: unknown) => caught);
      } finally {
        await api.releaseMaintenance("op-teen");
      }
    });
    expect(error).toBeInstanceOf(MemberError);
    expect((error as MemberError).code).toBe("MAINTENANCE_ACTIVE");
  });
});
