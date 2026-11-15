import { describe, expect, it } from "vitest";
import {
  CLAIM_WINDOW_MINUTES,
  claimWindowOpen,
  decideOwner,
  ownerStatusOf,
  type OwnerClaimView,
  type OwnerConfigView,
} from "../../src/channels/owner-access";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const unclaimed = (openedAt = NOW): OwnerClaimView => ({
  ownerUserId: null,
  windowOpenedAt: openedAt,
});
const claimed = (userId = "111"): OwnerClaimView => ({
  ownerUserId: userId,
  windowOpenedAt: NOW,
});
const staticList = (ids: number[]): OwnerConfigView => ({
  telegramUserIds: ids,
});
const pending: OwnerConfigView = { telegramUserIds: undefined };

function decide(
  config: OwnerConfigView,
  claim: OwnerClaimView,
  userId = "999",
): string {
  return decideOwner({ config, claim, userId, now: NOW });
}

describe("decideOwner", () => {
  it("静态名单命中放行、未命中拒绝", () => {
    expect(decide(staticList([111]), unclaimed(), "111")).toBe("allow");
    expect(decide(staticList([111]), unclaimed())).toBe("deny");
  });

  it("静态名单未命中，即使窗口开着也不认领", () => {
    expect(decide(staticList([111]), unclaimed(), "999")).toBe("deny");
  });

  it("空数组是硬关闭", () => {
    expect(decide(staticList([]), unclaimed(), "999")).toBe("deny");
    expect(decide(staticList([]), claimed("999"), "999")).toBe("deny");
  });

  it("缺省 + 已认领：id 匹配放行，其他人拒绝", () => {
    expect(decide(pending, claimed("111"), "111")).toBe("allow");
    expect(decide(pending, claimed("111"), "999")).toBe("deny");
  });

  it("缺省 + 未认领 + 窗口开 = 认领", () => {
    expect(decide(pending, unclaimed())).toBe("claim");
  });

  it("缺省 + 未认领 + 窗口过期 = 拒绝", () => {
    const old = unclaimed(NOW - CLAIM_WINDOW_MINUTES * MINUTE - 1);
    expect(decide(pending, old)).toBe("deny");
  });

  it("撤销后的窗口（起点 0）不再认领", () => {
    expect(decide(pending, unclaimed(0))).toBe("deny");
  });

  it("数字 id 按字符串比较", () => {
    expect(decide(staticList([111]), unclaimed(), "0111")).toBe("deny");
  });

  it("窗口边界含端点", () => {
    expect(claimWindowOpen(NOW - CLAIM_WINDOW_MINUTES * MINUTE, NOW)).toBe(true);
    expect(
      claimWindowOpen(NOW - CLAIM_WINDOW_MINUTES * MINUTE - 1, NOW),
    ).toBe(false);
  });
});

describe("ownerStatusOf", () => {
  it("静态与关闭分别报告", () => {
    expect(
      ownerStatusOf({ config: staticList([1]), claim: unclaimed(), now: NOW })
        .mode,
    ).toBe("static");
    expect(
      ownerStatusOf({ config: staticList([]), claim: unclaimed(), now: NOW })
        .mode,
    ).toBe("closed");
  });

  it("已认领报告主人 id", () => {
    const status = ownerStatusOf({
      config: pending,
      claim: claimed("111"),
      now: NOW,
    });
    expect(status.mode).toBe("claimed");
    expect(status.ownerUserId).toBe("111");
  });

  it("撤销（起点 0 + 无主人）与配置空名单区分开：前者是 revoked", () => {
    expect(
      ownerStatusOf({ config: pending, claim: unclaimed(0), now: NOW }).mode,
    ).toBe("revoked");
    expect(
      ownerStatusOf({ config: staticList([]), claim: unclaimed(0), now: NOW })
        .mode,
    ).toBe("closed");
  });

  it("窗口开 → claimable，过期 → expired", () => {
    expect(
      ownerStatusOf({ config: pending, claim: unclaimed(), now: NOW }).mode,
    ).toBe("claimable");
    expect(
      ownerStatusOf({
        config: pending,
        claim: unclaimed(NOW - 61 * MINUTE),
        now: NOW,
      }).mode,
    ).toBe("expired");
  });

  it("窗口关闭时不给窗口结束时间", () => {
    expect(
      ownerStatusOf({ config: pending, claim: unclaimed(0), now: NOW })
        .windowClosesAt,
    ).toBeNull();
    expect(
      ownerStatusOf({ config: pending, claim: unclaimed(), now: NOW })
        .windowClosesAt,
    ).toBe(NOW + CLAIM_WINDOW_MINUTES * MINUTE);
  });
});
