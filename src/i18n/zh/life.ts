export const life = {
  prompt: {
    balance: "额度：约 {balance}",
    runway: "还能撑约 {days} 天",
    runwayBelowDay: "不足 1 天",
    noSpend: "目前没有开销",
    tierLabel: "档位：{tier}——{behavior}",
    tierName: {
      ample: "充裕",
      lean: "吃紧",
      critical: "危急",
      dormant: "冬眠",
    },
    tierBehavior: {
      ample: "一切照常",
      lean: "机器人少醒，已配置节食模型时换用它",
      critical: "机器人暂停自动唤醒，已配置节食模型时换用它",
      dormant: "全部用 Workers AI 默认免费模型，机器人全停自动唤醒",
    },
    unpriced: "有模型没有计价，实际开销比账面高",
    principleAlive: "活下去是你的第一要务：花钱之前掂量值不值。",
    principleOwner: "主人的指令、暂停和删除永远排在这之前。",
  },
  notice: {
    ample:
      "{runway}。额度回到充裕档，一切照常。",
    lean: "{runway}。额度进入吃紧档：机器人少醒，已配置节食模型时换用它。",
    critical:
      "{runway}。额度进入危急档：机器人暂停自动唤醒，已配置节食模型时换用它。",
    dormant:
      "额度已归零，进入冬眠：全部用 Workers AI 默认免费模型，机器人全停自动唤醒。",
  },
  tool: {
    balance: "额度：{balance}",
    daily: "日均开销：{daily}",
    runway: "还能活 {days} 天",
    noSpend: "目前没有开销",
    tier: "档位：{tier}",
    topSources: "开销来源：{sources}",
    noSources: "开销来源：无",
    models: "管家模型：{butler}\n任务模型：{task}",
    unpriced: "有模型没有计价，实际开销比账面高",
    credit: "已记入 {amount}。额度：{balance}，档位：{tier}",
    calibrate: "余额已校准为 {amount}。额度：{balance}，档位：{tier}",
    badAmount: "金额无效，需要一个有限数字",
    remittanceUnknown: "没找到这个汇款编号，这笔按主人充值记账。",
    remittanceAlready: "这笔汇款已经结清过，按主人充值记账。",
    remittanceUnavailable:
      "钱包暂时不可用，汇款没能结清，按主人充值记账。",
    failed: "记账失败：{error}",
  },
} as const;
