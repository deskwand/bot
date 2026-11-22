import { describe, expect, it } from "vitest";
import { adminInviteView } from "../../src/members/admin-view";
import type { InviteRecord } from "../../src/members/store";
import type { InviteView } from "../../src/channels/wechat/login";

const invite = (over: Partial<InviteRecord> = {}): InviteRecord => ({
  inviteId: "i1",
  label: "小王",
  kind: "new",
  status: "pending",
  expiresAt: 1_700_000_000_000,
  memberId: null,
  targetMemberId: null,
  expectedUserId: null,
  tokenHash: "digest",
  createdAt: 1,
  ...over,
});

const login = (over: Partial<InviteView> = {}): InviteView => ({
  inviteId: "i1",
  stage: "realname",
  expiresAt: 1_700_000_000_000,
  generation: 1,
  scanned: false,
  ...over,
});

describe("adminInviteView", () => {
  it("shows a freshly created invite as starting, never as idle", () => {
    expect(adminInviteView(invite(), null, 1)).toMatchObject({
      stage: "starting",
      status: "pending",
    });
    expect(adminInviteView(invite(), login({ stage: "idle" }), 1).stage).toBe(
      "starting",
    );
  });

  it("maps the invite row's terminal states onto stages", () => {
    expect(adminInviteView(invite({ status: "cancelled" }), null, 1).stage).toBe(
      "cancelled",
    );
    expect(adminInviteView(invite({ status: "consumed" }), null, 1).stage).toBe(
      "confirmed",
    );
  });

  it("reports an expired pending invite as expired", () => {
    expect(adminInviteView(invite(), null, 1_700_000_000_001).stage).toBe(
      "expired",
    );
  });

  it("counts the real-name window down even before the link exists", () => {
    const view = adminInviteView(
      invite(),
      login({ realnameDeadline: 1_700_000_100_000 }),
      1,
    );
    expect(view.realnameDeadline).toBe(1_700_000_100_000);
    expect(view.realnameUrl).toBeUndefined();
  });

  it("hands the real-name link only in the real-name stage", () => {
    const url = "https://liteapp.weixin.qq.com/q/abc";
    expect(
      adminInviteView(invite(), login({ authUrl: url }), 1).realnameUrl,
    ).toBe(url);
    expect(
      adminInviteView(invite(), login({ stage: "scan", authUrl: url }), 1)
        .realnameUrl,
    ).toBeUndefined();
  });

  it("hands the bind content only while scanning, never in the pin stage", () => {
    expect(
      adminInviteView(invite(), login({ stage: "scan", qrImage: "qr" }), 1)
        .qrContent,
    ).toBe("qr");
    expect(
      adminInviteView(invite(), login({ stage: "pin", qrImage: "qr" }), 1)
        .qrContent,
    ).toBeUndefined();
  });

  it("keeps a known failure and folds anything else into unknown", () => {
    expect(
      adminInviteView(invite(), login({ failure: "realname_denied" }), 1)
        .failure,
    ).toBe("realname_denied");
    expect(
      adminInviteView(invite(), login({ failure: "weird" as never }), 1).failure,
    ).toBe("unknown");
  });
});
