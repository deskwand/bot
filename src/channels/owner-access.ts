/**
 * 谁是主人：纯判定，不碰存储、不发网络请求。
 *
 * 配置形态决定模式，认领只在「配置里没有 owner 键」时参与：
 * - 非空名单 = 静态白名单（认领一行都不能生效）
 * - 空数组 = 明确关闭
 * - 缺省 = 待认领
 */

/** 认领窗口长度。固定值：没有第二个使用场景，不做配置项。 */
export const CLAIM_WINDOW_MINUTES = 60;

export type OwnerConfigView = {
  /** undefined = 缺省（待认领）；[] = 明确关闭；非空 = 静态白名单。 */
  telegramUserIds: number[] | undefined;
};

export type OwnerClaimView = {
  ownerUserId: string | null;
  /** 0 = 窗口已关闭（撤销或从未开启）。 */
  windowOpenedAt: number;
};

export type OwnerDecision = "allow" | "claim" | "deny";

export type OwnerStatusMode =
  | "static"
  | "closed"
  | "claimed"
  | "claimable"
  | "expired";

/** 给管理接口用的状态快照。 */
export type OwnerStatus = {
  mode: OwnerStatusMode;
  ownerUserId: string | null;
  windowOpenedAt: number | null;
  windowClosesAt: number | null;
};

/** 窗口是否还开着；起点 0 表示已关闭。 */
export function claimWindowOpen(windowOpenedAt: number, now: number): boolean {
  if (windowOpenedAt <= 0) return false;
  return now <= windowOpenedAt + CLAIM_WINDOW_MINUTES * 60_000;
}

export function decideOwner(input: {
  config: OwnerConfigView;
  claim: OwnerClaimView;
  userId: string;
  now: number;
}): OwnerDecision {
  const { config, claim, userId, now } = input;
  const ids = config.telegramUserIds;

  // 非空名单与空数组都走这里：配置说了算，认领不参与。
  if (ids !== undefined) {
    return ids.some((id) => String(id) === userId) ? "allow" : "deny";
  }
  if (claim.ownerUserId !== null) {
    return claim.ownerUserId === userId ? "allow" : "deny";
  }
  return claimWindowOpen(claim.windowOpenedAt, now) ? "claim" : "deny";
}

export function ownerStatusOf(input: {
  config: OwnerConfigView;
  claim: OwnerClaimView;
  now: number;
}): OwnerStatus {
  const { config, claim, now } = input;
  const ids = config.telegramUserIds;

  const mode: OwnerStatusMode =
    ids !== undefined && ids.length > 0
      ? "static"
      : ids !== undefined
        ? "closed"
        : claim.ownerUserId !== null
          ? "claimed"
          : claim.windowOpenedAt <= 0
            ? "closed"
            : claimWindowOpen(claim.windowOpenedAt, now)
              ? "claimable"
              : "expired";

  return {
    mode,
    ownerUserId: claim.ownerUserId,
    windowOpenedAt: claim.windowOpenedAt > 0 ? claim.windowOpenedAt : null,
    windowClosesAt:
      claim.windowOpenedAt > 0
        ? claim.windowOpenedAt + CLAIM_WINDOW_MINUTES * 60_000
        : null,
  };
}
