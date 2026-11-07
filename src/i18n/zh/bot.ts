export const bot = {
  finished: "{name} 已结束，不会再唤醒（原因：{reason}）",
  finishReasonUnknown: "未说明",
  dailyLimit: "{name} 今日唤醒已达 {limit} 次，推迟到明天 00:00 UTC",
  failing:
    "{name} 连续 {failures} 次失败（最近原因：{reason}），会继续每 {retryEvery} 重试一次",
  recovered: "{name} 已恢复正常",
  runTimeout: "运行超过 24 小时，已取消",
} as const;
