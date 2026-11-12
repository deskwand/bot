export const wallet = {
  status: {
    title: "钱包",
    address: "地址：{address}",
    holdings: "持仓：{holdings}",
    holding: "{token} {amount}",
    noHoldings: "持仓：无",
    value: "总估值：{value}",
    pending: "待确认的汇款：{id}（{usdc}）",
    noPending: "待确认的汇款：无",
  },
  vitals: {
    unavailable: "钱包：暂不可用",
  },
  prompt: {
    value: "钱包估值：{value}",
  },
  error: {
    rpc: "链上暂时不可用，这笔汇款没有完成。",
    busy: "上一笔汇款还没确认，先不发新的。",
    bad_amount: "金额无效，需要一个有限的正数。",
    below_min: "金额低于最小汇款额。",
    insufficient: "链上余额不足。",
    unconfigured: "钱包还没配置。",
    reverted: "这笔交易在链上回滚了。",
    abandoned: "这笔汇款还没签名就被中断了。",
    replaced: "这笔交易被同 nonce 的另一笔交易取代了，不会再上链。",
    stuck:
      "汇款发出后一直没上链，可能是 ETH 不够付 gas；补点 ETH 后会自动重发。",
  },
  notice: {
    remit:
      "已把 {usdc} 汇到你的地址，交易记录：{txUrl}（汇款编号 {id}）。充值后告诉我，我记一笔入账。",
    remitShort: "这次汇出的金额离需要的还差 {short}。",
    failed: "这次 {usdc} 的汇款没有发出去：{reason} 等下次档位变化再试。",
  },
} as const;
