import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ButlerDO } from "../../src/butler/butler-do";
import { TasksRepo } from "../../src/butler/tasks-repo";
import { ChannelDO } from "../../src/channels/channel-do";
import {
  setILinkFetchOverride,
  setWeChatCredentialsOverride,
} from "../../src/channels/override";
import {
  AttachmentAccess,
  migrateLegacyInbox,
} from "../../src/members/artifact-access";
import { PRIVATE_WECHAT_PREFIX } from "../../src/members/credentials";
import { ownerPrincipal } from "../../src/members/principal";
import { MemberStore } from "../../src/members/store";
import type { MessageEvent } from "../../src/protocol";
import { memberBinding, seedLegacySchema } from "../helpers/members";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const CREDS = {
  token: "token-m",
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "account-m",
  userId: memberBinding.userId,
};

function channelStub(name: string) {
  return env.CHANNELS.get(
    env.CHANNELS.idFromName(`${name}-${crypto.randomUUID()}`),
  );
}

afterEach(() => {
  setILinkFetchOverride(null);
  setWeChatCredentialsOverride(null);
  vi.restoreAllMocks();
});

describe("ChannelDO member boundaries", () => {
  it("成员已占用该身份时主人导入被拒且不进入旧轮询", async () => {
    const calls: string[] = [];
    setWeChatCredentialsOverride(JSON.stringify(CREDS));
    setILinkFetchOverride((async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch);

    const stub = channelStub("member-import-conflict");
    await runInDurableObject(stub, async (instance, state) => {
      const store = new MemberStore(state.storage.sql, undefined, (fn) =>
        state.storage.transactionSync(fn),
      );
      const invite = store.createInvite("小王");
      store.completeInvite(invite.inviteId, memberBinding);

      const before = state.storage.sql
        .exec(`SELECT credentials_hash FROM wechat_state LIMIT 1`)
        .toArray();
      const target = instance as unknown as {
        startWeChatPolling(): Promise<void>;
      };
      await target.startWeChatPolling();

      // The rejected owner candidate never becomes admitted state.
      expect(
        state.storage.sql
          .exec(`SELECT credentials_hash FROM wechat_state LIMIT 1`)
          .toArray(),
      ).toEqual(before);
      expect(
        state.storage.sql
          .exec(
            `SELECT member_id FROM member_connections WHERE member_id = 'owner'`,
          )
          .toArray(),
      ).toEqual([]);
      // No candidate credential is left behind in the private namespace.
      const stored = await state.storage.list({
        prefix: PRIVATE_WECHAT_PREFIX,
      });
      expect([...stored.keys()]).toEqual([]);
    });
    expect(calls).toEqual([]);
  });

  it("入站文件在送达管家时立即登记归属", async () => {
    const stub = channelStub("member-inbound");
    const key = "inbox/wx:inbound-1/a.txt";
    await runInDurableObject(stub, async (instance, state) => {
      const attachments = new AttachmentAccess(state.storage.sql);
      expect(attachments.owns("owner", key)).toBe(false);

      const event: MessageEvent = {
        type: "message",
        channel: "wechat",
        chatId: memberBinding.userId,
        userId: memberBinding.userId,
        text: "hi",
        eventId: "wx:inbound-1",
        files: [
          { name: "a.txt", key, mimeType: "text/plain", size: 3 },
        ],
      };
      const target = instance as unknown as {
        dispatchMessage(event: MessageEvent, routeKey: string): boolean;
      };
      target.dispatchMessage(event, "route-inbound");

      const after = new AttachmentAccess(state.storage.sql);
      expect(after.owns("owner", key)).toBe(true);
    });
  });

  it("迁移完成后新入站文件仍能解析归属", async () => {
    const stub = channelStub("member-inbound-after-migration");
    const key = "inbox/wx:inbound-2/b.txt";
    await runInDurableObject(stub, async (instance, state) => {
      // An upgraded database: the legacy schema and its one-time adoption are
      // what the production constructor would have found at first boot.
      seedLegacySchema(state.storage.sql);
      const store = new MemberStore(state.storage.sql, undefined, (fn) =>
        state.storage.transactionSync(fn),
      );
      store.ensureOwner();
      const attachments = new AttachmentAccess(state.storage.sql);
      await migrateLegacyInbox({
        sql: state.storage.sql,
        access: attachments,
        list: async () => ({ keys: ["inbox/old/c.txt"] }),
      });
      expect(attachments.owns("owner", "inbox/old/c.txt")).toBe(true);
      expect(attachments.owns("owner", key)).toBe(false);

      const target = instance as unknown as {
        dispatchMessage(event: MessageEvent, routeKey: string): boolean;
      };
      target.dispatchMessage(
        {
          type: "message",
          channel: "telegram",
          chatId: "1",
          userId: "1",
          text: null,
          eventId: "tg:9",
          files: [{ name: "b.txt", key, mimeType: "text/plain", size: 3 }],
        },
        "route-inbound-2",
      );
      expect(new AttachmentAccess(state.storage.sql).owns("owner", key)).toBe(
        true,
      );
    });
  });

  it("ChannelDO 暴露真实的任务归属 ACL RPC", async () => {
    const butler = env.BUTLER.get(env.BUTLER.idFromName("owner"));
    await runInDurableObject(butler, (_instance, state) => {
      new ButlerDO(state, env as unknown as Env);
      new TasksRepo(state.storage.sql).insert({
        id: "t1",
        title: "acl",
        chatId: null,
      });
    });

    const stub = channelStub("member-acl-rpc");
    const actor = ownerPrincipal();
    // Success paths over real DO RPC.
    await stub.registerTaskArtifact(actor, "t1", "t1/report.txt");
    expect(await stub.resolveMemberAttachment(actor, "t1/report.txt")).toBe(
      "t1/report.txt",
    );

    // Failures are asserted inside the object: a rejected DO RPC surfaces as
    // an unhandled rejection in miniflare even when the test catches it.
    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.registerTaskArtifact(actor, "t404", "t404/x.txt"),
      ).rejects.toThrow("TASK_NOT_FOUND");
      await expect(
        instance.registerTaskArtifact(actor, "t1", "t1/../inbox/e1/a.txt"),
      ).rejects.toThrow("ARTIFACT_KEY_MISMATCH");
      await expect(
        instance.resolveMemberAttachment(actor, "inbox/e1/unknown.txt"),
      ).rejects.toThrow("MEMBER_ACCESS_DENIED");
    });
  });
});
