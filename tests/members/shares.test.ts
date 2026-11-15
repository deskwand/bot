import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { artifactStore } from "../../src/artifact-store";
import { t } from "../../src/i18n";
import { AttachmentAccess } from "../../src/members/artifact-access";
import { OWNER_ID, ownerPrincipal, type Principal } from "../../src/members/principal";
import {
  createShareTools,
  parseShareCommand,
  ShareService,
  SHARE_DIGEST_MISMATCH,
  SHARE_EMPTY,
  SHARE_EXPIRED,
  SHARE_MAX_FILES,
  SHARE_NOT_FOUND,
  SHARE_RECIPIENT_AMBIGUOUS,
  SHARE_RECIPIENT_UNKNOWN,
  SHARE_TOO_LARGE,
  SHARE_TOO_MANY_FILES,
  type SharePreview,
} from "../../src/members/shares";
import { MemberStore, type MemberView, type VerifiedBinding } from "../../src/members/store";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${crypto.randomUUID().slice(0, 8)}`;
}

function binding(): VerifiedBinding {
  const id = unique("b");
  return {
    connectionId: `c-${id}`,
    credentialKey: `credential-${id}`,
    accountId: `acct-${id}`,
    userId: `user-${id}`,
    credentialHash: `hash-${id}`,
  };
}

type Delivered =
  | { kind: "text"; memberId: string; text: string }
  | { kind: "file"; memberId: string; key: string };

type Fixture = {
  sql: SqlStorage;
  store: MemberStore;
  access: AttachmentAccess;
  shares: ShareService;
  clock: { now: number };
  sent: Delivered[];
  owner: Principal;
  bucket: ReturnType<typeof artifactStore>;
  put(key: string, content: string | Uint8Array, mime?: string): Promise<void>;
  addMember(label: string): MemberView;
  actorOf(memberId: string): Principal;
  statusOf(shareId: string): string | undefined;
};

function stub(name: string) {
  return env.CHANNELS.get(env.CHANNELS.idFromName(unique(name)));
}

function withShares<T>(run: (fixture: Fixture) => Promise<T> | T): Promise<T> {
  return runInDurableObject(stub("shares-test"), async (_instance, state) => {
    const sql = state.storage.sql;
    const clock = { now: NOW };
    const store = new MemberStore(
      sql,
      () => clock.now,
      (fn) => state.storage.transactionSync(fn),
    );
    store.ensureOwner();
    const access = new AttachmentAccess(sql);
    const bucket = artifactStore(env);
    const sent: Delivered[] = [];
    const shares = new ShareService({
      sql,
      members: store,
      access,
      read: async (key) => {
        const object = await bucket.get(key);
        if (!object) return null;
        return {
          bytes: new Uint8Array(await object.arrayBuffer()),
          mime: object.httpMetadata?.contentType ?? "application/octet-stream",
        };
      },
      write: async (key, bytes, mime) => {
        await bucket.put(key, bytes, { httpMetadata: { contentType: mime } });
      },
      deliver: {
        text: async (actor, text) => {
          sent.push({ kind: "text", memberId: actor.memberId, text });
        },
        file: async (actor, key) => {
          sent.push({ kind: "file", memberId: actor.memberId, key });
        },
      },
      now: () => clock.now,
    });

    const fixture: Fixture = {
      sql,
      store,
      access,
      shares,
      clock,
      sent,
      owner: ownerPrincipal(),
      bucket,
      put: async (key, content, mime = "text/plain") => {
        const bytes =
          typeof content === "string" ? new TextEncoder().encode(content) : content;
        await bucket.put(key, bytes, { httpMetadata: { contentType: mime } });
      },
      addMember: (label) => store.completeInvite(store.createInvite(label).inviteId, binding()),
      actorOf: (memberId) => {
        const actor = store.principal(memberId);
        if (!actor) throw new Error("missing actor");
        return actor;
      },
      statusOf: (shareId) =>
        sql
          .exec<{ status: string }>(
            `SELECT status FROM member_shares WHERE share_id = ?`,
            shareId,
          )
          .toArray()[0]?.status,
    };
    return run(fixture);
  });
}

/** Stores the bytes and registers the ACL row, exactly like intake does. */
async function ownFile(
  fixture: Fixture,
  memberId: string,
  key: string,
  content: string,
): Promise<string> {
  await fixture.put(key, content);
  fixture.access.record(memberId, key);
  return key;
}

describe("ShareService.prepare", () => {
  it("未知 key 与别人名下的 key 都被拒绝，主人也不例外", async () => {
    await withShares(async (fixture) => {
      const a = fixture.addMember("小王");
      const aKey = await ownFile(fixture, a.memberId, "inbox/e-a/a.txt", "A");
      const ownerKey = await ownFile(
        fixture,
        OWNER_ID,
        "inbox/e-o/owner.txt",
        "owner",
      );

      // The owner is not excused: a key registered to a member is never theirs.
      await expect(
        fixture.shares.prepare(fixture.owner, a.memberId, "hi", [aKey]),
      ).rejects.toThrow("MEMBER_ACCESS_DENIED");
      // An unknown key is never allowed just because the sender is the owner.
      await expect(
        fixture.shares.prepare(fixture.owner, a.memberId, "hi", [
          "inbox/unknown/x.txt",
        ]),
      ).rejects.toThrow("MEMBER_ACCESS_DENIED");
      // A member cannot lift the owner's key into a share either.
      await expect(
        fixture.shares.prepare(fixture.actorOf(a.memberId), OWNER_ID, "hi", [
          ownerKey,
        ]),
      ).rejects.toThrow("MEMBER_ACCESS_DENIED");

      const preview = await fixture.shares.prepare(
        fixture.owner,
        a.memberId,
        "hi",
        [ownerKey],
      );
      expect(preview.shareId).toBe("sh1");
      expect(preview.recipientLabel).toBe("小王");
      expect(preview.files).toEqual([ownerKey]);
      expect(preview.expiresAt).toBe(NOW + 10 * MINUTE);
      expect(fixture.sent).toHaveLength(0);
    });
  });

  it("空内容、超五个文件、超过 15MB 都拒绝", async () => {
    await withShares(async (fixture) => {
      const a = fixture.addMember("小王");
      const ownerKey = await ownFile(
        fixture,
        OWNER_ID,
        "inbox/e1/owner.txt",
        "owner",
      );

      await expect(
        fixture.shares.prepare(fixture.owner, a.memberId, "   ", []),
      ).rejects.toThrow(SHARE_EMPTY);

      const many: string[] = [];
      for (let i = 0; i < SHARE_MAX_FILES + 1; i += 1) {
        many.push(
          await ownFile(fixture, OWNER_ID, `inbox/e1/f${i}.txt`, `f${i}`),
        );
      }
      await expect(
        fixture.shares.prepare(fixture.owner, a.memberId, "hi", many),
      ).rejects.toThrow(SHARE_TOO_MANY_FILES);

      // 8MB + 8MB is over the 15MB total budget; each file alone is legal.
      const big = new Uint8Array(8 << 20).fill(7);
      const bigOne = await ownFile(fixture, OWNER_ID, "inbox/e1/big-a.bin", "x");
      await fixture.put(bigOne, big, "application/octet-stream");
      const bigTwo = await ownFile(fixture, OWNER_ID, "inbox/e1/big-b.bin", "x");
      await fixture.put(bigTwo, big, "application/octet-stream");
      await expect(
        fixture.shares.prepare(fixture.owner, a.memberId, "hi", [bigOne, bigTwo]),
      ).rejects.toThrow(SHARE_TOO_LARGE);

      const ok = await fixture.shares.prepare(fixture.owner, a.memberId, "hi", [
        ownerKey,
      ]);
      expect(fixture.statusOf(ok.shareId)).toBe("pending");
    });
  });

  it("接收人标签必须唯一，未知或歧义都不猜", async () => {
    await withShares(async (fixture) => {
      fixture.addMember("同名");
      fixture.addMember("同名");
      const unique = fixture.addMember("唯一");

      expect(() => fixture.shares.resolveRecipient("不存在")).toThrow(
        SHARE_RECIPIENT_UNKNOWN,
      );
      expect(() => fixture.shares.resolveRecipient("同名")).toThrow(
        SHARE_RECIPIENT_AMBIGUOUS,
      );
      expect(fixture.shares.resolveRecipient(" 唯一 ").memberId).toBe(
        unique.memberId,
      );
      expect(fixture.shares.resolveRecipient(OWNER_ID).memberId).toBe(OWNER_ID);
    });
  });
});

describe("ShareService.confirm", () => {
  it("接收人拿到自己的副本，发送人保留原件", async () => {
    await withShares(async (fixture) => {
      const a = fixture.addMember("小王");
      const key = await ownFile(
        fixture,
        OWNER_ID,
        "inbox/e1/report.txt",
        "hello",
      );
      const preview = await fixture.shares.prepare(
        fixture.owner,
        a.memberId,
        "这是报告",
        [key],
      );

      const result = await fixture.shares.confirm(fixture.owner, preview.shareId);
      expect(result.status).toBe("sent");
      expect(result.delivered).toBe(2);
      expect(fixture.statusOf(preview.shareId)).toBe("sent");

      const copyKey = `inbox/share-${preview.shareId}/report.txt`;
      const copy = await fixture.bucket.get(copyKey);
      expect(copy).not.toBeNull();
      expect(await copy!.text()).toBe("hello");
      // The recipient owns the copy, the sender still owns the original, and
      // the copy is not reachable through the recipient's original ACL.
      expect(fixture.access.owns(a.memberId, copyKey)).toBe(true);
      expect(fixture.access.owns(OWNER_ID, copyKey)).toBe(false);
      expect(fixture.access.owns(OWNER_ID, key)).toBe(true);
      expect(fixture.access.owns(a.memberId, key)).toBe(false);
      expect(fixture.sent).toEqual([
        { kind: "text", memberId: a.memberId, text: "这是报告" },
        { kind: "file", memberId: a.memberId, key: copyKey },
      ]);
    });
  });

  it("非发送者确认被拒，且不发任何东西", async () => {
    await withShares(async (fixture) => {
      const a = fixture.addMember("小王");
      const b = fixture.addMember("小李");
      const key = await ownFile(fixture, a.memberId, "inbox/e-a/a.txt", "A");
      const preview = await fixture.shares.prepare(
        fixture.actorOf(a.memberId),
        b.memberId,
        "给你",
        [key],
      );

      await expect(
        fixture.shares.confirm(fixture.actorOf(b.memberId), preview.shareId),
      ).rejects.toThrow(SHARE_NOT_FOUND);
      await expect(
        fixture.shares.confirm(fixture.owner, preview.shareId),
      ).rejects.toThrow(SHARE_NOT_FOUND);
      expect(fixture.sent).toHaveLength(0);
      expect(fixture.statusOf(preview.shareId)).toBe("pending");
    });
  });

  it("重复确认只发送一次", async () => {
    await withShares(async (fixture) => {
      const a = fixture.addMember("小王");
      const key = await ownFile(fixture, OWNER_ID, "inbox/e1/a.txt", "A");
      const preview = await fixture.shares.prepare(
        fixture.owner,
        a.memberId,
        "一次",
        [key],
      );

      await fixture.shares.confirm(fixture.owner, preview.shareId);
      const sentOnce = fixture.sent.length;
      await expect(
        fixture.shares.confirm(fixture.owner, preview.shareId),
      ).rejects.toThrow(SHARE_NOT_FOUND);
      expect(fixture.sent).toHaveLength(sentOnce);
    });
  });

  it("字节被改过就作废，不发送", async () => {
    await withShares(async (fixture) => {
      const a = fixture.addMember("小王");
      const key = await ownFile(fixture, OWNER_ID, "inbox/e1/a.txt", "before");
      const preview = await fixture.shares.prepare(
        fixture.owner,
        a.memberId,
        "hi",
        [key],
      );

      await fixture.put(key, "after");
      await expect(
        fixture.shares.confirm(fixture.owner, preview.shareId),
      ).rejects.toThrow(SHARE_DIGEST_MISMATCH);
      expect(fixture.statusOf(preview.shareId)).toBe("invalid");
      expect(fixture.sent).toHaveLength(0);
    });
  });

  it("超过十分钟即失效，sweep 也会收走", async () => {
    await withShares(async (fixture) => {
      const a = fixture.addMember("小王");
      const key = await ownFile(fixture, OWNER_ID, "inbox/e1/a.txt", "A");
      const expired = await fixture.shares.prepare(
        fixture.owner,
        a.memberId,
        "过期",
        [key],
      );
      const swept = await fixture.shares.prepare(
        fixture.owner,
        a.memberId,
        "清扫",
        [key],
      );

      fixture.clock.now = NOW + 10 * MINUTE + 1;
      await expect(
        fixture.shares.confirm(fixture.owner, expired.shareId),
      ).rejects.toThrow(SHARE_EXPIRED);
      expect(fixture.statusOf(expired.shareId)).toBe("expired");
      expect(fixture.shares.sweepExpired()).toBe(1);
      expect(fixture.statusOf(swept.shareId)).toBe("expired");
      expect(fixture.sent).toHaveLength(0);
    });
  });

  it("prepare 与 confirm 之间撤销接收人或发送人都拦下", async () => {
    await withShares(async (fixture) => {
      const a = fixture.addMember("小王");
      const b = fixture.addMember("小李");
      const keyA = await ownFile(fixture, a.memberId, "inbox/e-a/a.txt", "A");
      const keyB = await ownFile(fixture, b.memberId, "inbox/e-b/b.txt", "B");

      const recipientGone = await fixture.shares.prepare(
        fixture.actorOf(a.memberId),
        b.memberId,
        "给小李",
        [keyA],
      );
      const senderGone = await fixture.shares.prepare(
        fixture.actorOf(b.memberId),
        a.memberId,
        "给小王",
        [keyB],
      );

      const staleSender = fixture.actorOf(b.memberId);
      fixture.store.revoke(b.memberId);

      await expect(
        fixture.shares.confirm(fixture.actorOf(a.memberId), recipientGone.shareId),
      ).rejects.toThrow("MEMBER_ACCESS_DENIED");
      expect(fixture.statusOf(recipientGone.shareId)).toBe("invalid");

      await expect(
        fixture.shares.confirm(staleSender, senderGone.shareId),
      ).rejects.toThrow("MEMBER_ACCESS_DENIED");
      expect(fixture.sent).toHaveLength(0);
    });
  });

  it("取消后不能确认，取消本身也只有发送者能收回", async () => {
    await withShares(async (fixture) => {
      const a = fixture.addMember("小王");
      const key = await ownFile(fixture, OWNER_ID, "inbox/e1/a.txt", "A");
      const preview = await fixture.shares.prepare(
        fixture.owner,
        a.memberId,
        "hi",
        [key],
      );

      expect(fixture.shares.cancel(fixture.actorOf(a.memberId), preview.shareId)).toBe(
        false,
      );
      expect(fixture.shares.cancel(fixture.owner, preview.shareId)).toBe(true);
      expect(fixture.shares.cancel(fixture.owner, preview.shareId)).toBe(false);
      expect(fixture.statusOf(preview.shareId)).toBe("cancelled");
      await expect(
        fixture.shares.confirm(fixture.owner, preview.shareId),
      ).rejects.toThrow(SHARE_NOT_FOUND);
      expect(fixture.sent).toHaveLength(0);
    });
  });
});

describe("share text commands", () => {
  it("只认 确认分享/取消分享 加 shN", () => {
    expect(parseShareCommand("确认分享 sh1")).toEqual({
      action: "confirm",
      shareId: "sh1",
    });
    expect(parseShareCommand("  取消分享  sh12 ")).toEqual({
      action: "cancel",
      shareId: "sh12",
    });
    expect(parseShareCommand('"确认分享 sh3"')).toEqual({
      action: "confirm",
      shareId: "sh3",
    });
    expect(parseShareCommand("确认分享")).toBeNull();
    expect(parseShareCommand("确认分享 sh1 谢谢")).toBeNull();
    expect(parseShareCommand("批准 #1")).toBeNull();
    expect(parseShareCommand("sh1")).toBeNull();
  });
});

describe("prepare_share tool", () => {
  type Prepare = (
    actor: Principal,
    recipientLabel: string,
    text: string,
    attachmentKeys: string[],
  ) => Promise<SharePreview>;

  function toolWith(sent: Principal[], prepare: Prepare) {
    return createShareTools({
      resolveActor: () => {
        const actor = sent[sent.length - 1]!;
        return actor;
      },
      channel: { prepareShare: prepare },
      locale: "zh",
    })[0]!;
  }

  it("主人和成员都能用，返回的只是预览", async () => {
    await withShares(async (fixture) => {
      const a = fixture.addMember("小王");
      const seen: Principal[] = [];
      const preview = await fixture.shares.prepare(
        fixture.owner,
        a.memberId,
        "hi",
        [],
      );
      const tool = toolWith(seen, async () => preview);

      seen.push(fixture.owner);
      const ownerOut = await tool.execute!({
        recipientLabel: "小王",
        text: "hi",
      }, {} as never, {} as never);
      seen.push(fixture.actorOf(a.memberId));
      const memberOut = await tool.execute!({ recipientLabel: "主人", text: "hi" }, {} as never, {} as never);

      for (const out of [ownerOut, memberOut]) {
        const text = (out as { output: { text: string }[] }).output[0]!.text;
        expect(text).toContain(preview.shareId);
        expect(text).toContain("确认分享");
        expect(fixture.sent).toHaveLength(0);
      }
    });
  });

  it("标签歧义时请用户说清楚，不替用户挑人", async () => {
    await withShares(async (fixture) => {
      const scene: Principal[] = [fixture.owner];
      const tool = toolWith(scene, async () => {
        throw new Error(SHARE_RECIPIENT_AMBIGUOUS);
      });
      const out = await tool.execute!({ recipientLabel: "同名", text: "hi" }, {} as never, {} as never);
      expect((out as { output: { text: string }[] }).output[0]!.text).toBe(
        t("zh", "member.share.errors.SHARE_RECIPIENT_AMBIGUOUS"),
      );
    });
  });

  it("附件不属于发送者时按固定句子拒绝", async () => {
    await withShares(async (fixture) => {
      const scene: Principal[] = [fixture.owner];
      const tool = toolWith(scene, async () => {
        throw new Error("MEMBER_ACCESS_DENIED");
      });
      const out = await tool.execute!({
        recipientLabel: "小王",
        text: "hi",
        attachmentKeys: ["inbox/other/x.txt"],
      }, {} as never, {} as never);
      expect((out as { output: { text: string }[] }).output[0]!.text).toBe(
        t("zh", "member.share.errors.MEMBER_ACCESS_DENIED"),
      );
    });
  });
});
