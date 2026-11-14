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
   * 认领行；没有行时按「窗口从此刻开始」写一行。
   *
   * 这个方法有写入副作用，所以每个调用方只调一次，不要在同一次改写里
   * 重复读它。
   */
  read(): OwnerClaimRow {
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

    if (row !== undefined) {
      return {
        ownerUserId: row.owner_user_id,
        claimedAt: row.claimed_at,
        windowOpenedAt: row.window_opened_at,
      };
    }

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

  openWindow(): void {
    const current = this.read();
    this.write({
      ownerUserId: current.ownerUserId,
      claimedAt: current.claimedAt,
      windowOpenedAt: this.now(),
    });
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
