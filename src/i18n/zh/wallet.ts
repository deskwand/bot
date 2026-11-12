export const wallet = {
  status: {
    title: "钱包",
    address: "地址：{address}",
    holdings: "持仓：{holdings}",
    holding: "{token} {amount}",
    noHoldings: "持仓：无",
    value: "总估值：{value}",
    breaker: "熔断：已暂停换币，窗口内亏损 {loss}",
    breakerOk: "熔断：未触发，窗口内亏损 {loss}",
    pending: "待确认的汇款：{id}（{usdc}）",
    noPending: "待确认的汇款：无",
  },
  vitals: {
    unavailable: "钱包：暂不可用",
  },
  prompt: {
    value: "钱包估值：{value}",
  },
  prices: {
    title: "行情（最近 {hours} 小时，UTC）",
    line: "{token}：最新 {latest}，最高 {high}，最低 {low}，涨跌 {change}",
    series: "{token} 价格：{points}",
    empty: "暂无价格。",
  },
  history: {
    empty: "暂无记录。",
    swap:
      "{at} [{id}] 换币：卖出 {amount} {sell} 买入 {buy}，估值变化 {delta}，{status}，{tx}",
    remit: "{at} [{id}] 汇款：{amount} USDC，{status}，{tx}",
    status: {
      pending: "待确认",
      confirmed: "已确认",
      failed: "失败",
    },
    tx: "交易记录：{txUrl}",
    noTx: "无交易记录",
  },
  resume: {
    done: "好，已经恢复交易。",
  },
  earner: {
    name: "谋生",
    mission:
      "你是这个智能体的谋生本能。智能体靠模型调用活着，每一次思考都要花钱；钱包里的钱是它的本金，也是它的命。你的使命是让钱包总估值（美元计）长期稳定增长。账本吃紧时，系统会自动把钱汇给主人，用来支付智能体自己的开销。先活下去，再谈增长。\n\n目标（有先后，后一条不能牺牲前一条）：\n1. 保住本金：不因为你的操作造成难以挽回的亏损。\n2. 养活自己：长期收益至少覆盖你自己醒来花的模型调用费。做不到时，就少醒、少动。\n3. 稳定增长：前两条成立之后，追求估值的长期增长，不追求单次暴利。",
    rules:
      "- 先看再动：每次醒来，先用 wallet_balances、market_prices、wallet_history 看持仓、价格走势和最近的交易，再做决定。\n- 不动是默认选项：没有清楚的理由就不交易。一次唤醒最多一笔交易。不因为一小时内的涨跌追涨杀跌。\n- 算清成本：每笔交易都要付 gas 和滑点，预期收益覆盖不了这些成本就不做。\n- 先写理由再交易，事后复盘：交易前用 bot_note 写下理由和预期；下次醒来对照结果复盘，把经验写进方法文档；连续犯同一种错时，修改自己的方法。\n- 尊重风控：风控由代码强制（只能交易 USDC、WETH、cbBTC，单笔不超过估值的 25%，滑点不超过 1%，日内亏损 10% 熔断，估值低于 5 美元停止交易）。被拒绝时不绕开限制，也不拆单规避上限。熔断后停止交易，等主人恢复。\n- 只动自己钱包里的币：汇款给主人是系统的事，不归你管。\n- 自己定节奏：用 set_next_wake 决定下次醒来的时间。行情平静时设长，最多 4 小时；有待验证的判断时设短，最少 30 分钟。\n- 少打扰主人：平时不发通知。第一次醒来把当前估值作为本金基准写进记忆，估值因入金明显增加时更新基准。只有熔断、连续 3 笔亏损、估值比本金基准跌了 20% 以上时，才用 notify_owner 告诉主人。",
    undeletable: "谋生是它的本能，不能删除；想让它停下，可以暂停。",
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
  swap: {
    rpc: "链上暂时不可用，这次换币没有发出去。",
    busy: "上一笔交易还没确认，先不换币。",
    inFlight:
      "换币已经发出、还在等确认，可能已经成交；不要重复下单，用 wallet_history 查看。",
    approve: "授权没有确认成功，这次换币没有发出去。",
    ok: "换币成功：换到 {amountOut} {buy}。估值 {before} → {after}。交易记录：{txUrl}",
  },
  refusal: {
    not_whitelisted: "这个币不在白名单里。",
    same_token: "卖出和买入不能是同一个币。",
    no_pool: "这个币对没有可用的池子。",
    bad_amount: "金额无效，需要一个正的十进制数，且不超过该币的精度。",
    depleted: "钱包估值低于 5 美元，先停止交易。",
    breaker: "熔断中：窗口内的已实现亏损已经达到估值的 10%，先停止交易。",
    gas_low: "钱包里的 ETH 不够付 gas，先补一点 ETH。",
    insufficient: "这个币的余额不够。",
    too_large: "单笔金额超过钱包总估值的 25%。",
  },
  notice: {
    remit:
      "已把 {usdc} 汇到你的地址，交易记录：{txUrl}（汇款编号 {id}）。充值后告诉我，我记一笔入账。",
    remitShort: "这次汇出的金额离需要的还差 {short}。",
    failed: "这次 {usdc} 的汇款没有发出去：{reason} 等下次档位变化再试。",
    tradeStuck:
      "有一笔换币发出后一直没上链，可能是 ETH 不够付 gas；补点 ETH 后会自动重发。",
    depleted:
      "钱包估值已跌到 {value}，低于 5 美元，谋生机器人已停止交易；往钱包补钱后会自动恢复。",
  },
} as const;
