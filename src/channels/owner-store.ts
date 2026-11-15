/**
 * 主人的认领记录。只存 ChannelDO 的 SQLite：容器部署的数据卷、Cloudflare 的
 * DO 存储都天然持久，所以换主人不需要重建容器、不需要发新版本。
 */
export type OwnerClaimRow = {
  ownerUserId: string | null;
  claimedAt: number | null;
  /** 0 = 窗口关闭。 */
  windowOpenedAt: number;
};

const CHANNEL = "telegram";

export class OwnerStore {
  private readonly sql: SqlStorage;

  private readonly now: () => number;

  constructor(sql: SqlStorage, now: () => number = Date.now) {
    this.sql = sql;
    this.now = now;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS channel_claims (
        channel TEXT PRIMARY KEY,
        owner_user_id TEXT,
        claimed_at INTEGER,
        window_opened_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
  }

  /**
   * 认领行；没有行时返回「没有主人、窗口未开启」（起点 0）。
   *
   * 读不写库：管理接口的状态查询不能顺带启动认领窗口。
   */
  read(): OwnerClaimRow {
    return this.select() ?? { ownerUserId: null, claimedAt: null, windowOpenedAt: 0 };
  }

  /** 原始行；存在但起点为 0 表示「关闭」，与「没有行」不同。 */
  private select(): OwnerClaimRow | null {
    const row = this.sql
      .exec<{
        owner_user_id: string | null;
        claimed_at: number | null;
        window_opened_at: number;
      }>(
        `SELECT owner_user_id, claimed_at, window_opened_at
         FROM channel_claims WHERE channel = ?`,
        CHANNEL,
      )
      .toArray()[0];

    if (row === undefined) return null;
    return {
      ownerUserId: row.owner_user_id,
      claimedAt: row.claimed_at,
      windowOpenedAt: row.window_opened_at,
    };
  }

  /**
   * 认领行；没有行时把窗口起点定为现在并写一行。
   *
   * 只有「真的要判定/开始认领」的路径才用它（DO 启动、收到消息）。状态查询
   * 走 read()，不能借读启动窗口。
   */
  ensureWindow(): OwnerClaimRow {
    // 有行就原样返回：起点 0 是「已撤销/已关闭」，不能被一条新消息重新打开。
    const current = this.select();
    if (current !== null) return current;
    const openedAt = this.now();
    this.write({ ownerUserId: null, claimedAt: null, windowOpenedAt: openedAt });
    return { ownerUserId: null, claimedAt: null, windowOpenedAt: openedAt };
  }

  claim(userId: string): void {
    const current = this.read();
    this.write({
      ownerUserId: userId,
      claimedAt: this.now(),
      windowOpenedAt: current.windowOpenedAt,
    });
    // 旧地址必须一起清掉：否则 Butler 手上的 message reference 会把消息
    // 推给上一个主人的 chat。
    this.clearAddresses();
  }

  /** 撤销认领并关闭窗口；要再开必须显式 openWindow。 */
  revoke(): void {
    this.write({ ownerUserId: null, claimedAt: null, windowOpenedAt: 0 });
    this.clearAddresses();
  }

  /**
   * 开窗 = 交棒：清掉当前主人并重新开始 60 分钟计时。
   *
   * 保留主人再开窗是骗人的 —— 已认领时窗口不参与判定，点「重新开启认领」
   * 的语义本来就是让下一个人接手。
   */
  openWindow(): void {
    this.write({ ownerUserId: null, claimedAt: null, windowOpenedAt: this.now() });
    this.clearAddresses();
  }

  private clearAddresses(): void {
    this.sql.exec(`DELETE FROM owner_addresses WHERE channel = ?`, CHANNEL);
  }

  private write(row: OwnerClaimRow): void {
    this.sql.exec(
      `INSERT INTO channel_claims
         (channel, owner_user_id, claimed_at, window_opened_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET
         owner_user_id = excluded.owner_user_id,
         claimed_at = excluded.claimed_at,
         window_opened_at = excluded.window_opened_at,
         updated_at = excluded.updated_at`,
      CHANNEL,
      row.ownerUserId,
      row.claimedAt,
      row.windowOpenedAt,
      this.now(),
    );
  }
}
