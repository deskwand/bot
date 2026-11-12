import type { Messages } from "../messages";

export const wallet: Messages["wallet"] = {
  status: {
    title: "Wallet",
    address: "Address: {address}",
    holdings: "Holdings: {holdings}",
    holding: "{token} {amount}",
    noHoldings: "Holdings: none",
    value: "Total value: {value}",
    breaker: "Breaker: trading paused, {loss} lost in the window",
    breakerOk: "Breaker: not tripped, {loss} lost in the window",
    pending: "Pending remittance: {id} ({usdc})",
    noPending: "Pending remittance: none",
  },
  vitals: {
    unavailable: "Wallet: unavailable",
  },
  prompt: {
    value: "Wallet value: {value}",
  },
  prices: {
    title: "Prices (last {hours} hours, UTC)",
    line: "{token}: latest {latest}, high {high}, low {low}, change {change}",
    series: "{token} price: {points}",
    empty: "No prices yet.",
  },
  history: {
    empty: "No history yet.",
    swap:
      "{at} [{id}] swap: sold {amount} {sell} for {buy}, value change {delta}, {status}, {tx}",
    remit: "{at} [{id}] remittance: {amount} USDC, {status}, {tx}",
    status: {
      pending: "pending",
      confirmed: "confirmed",
      failed: "failed",
    },
    tx: "Transaction: {txUrl}",
    noTx: "no transaction",
  },
  resume: {
    done: "Done; trading is resumed.",
  },
  earner: {
    name: "Livelihood",
    mission:
      "You are this agent's instinct for earning a living. The agent lives on model calls, and every thought costs money; the money in the wallet is its capital and its life. Your mission is to make the wallet's total value (in US dollars) grow steadily over the long term. When the ledger runs tight, the system automatically remits money to the owner to pay the agent's own costs. Survive first, then grow.\n\nGoals (in order; a later one must not sacrifice an earlier one):\n1. Protect the principal: do not cause losses from your operations that are hard to recover.\n2. Support yourself: long-term returns should at least cover the model fees you spend waking up. When they cannot, wake less and act less.\n3. Grow steadily: once the first two hold, pursue long-term growth in value, not one-off windfalls.",
    rules:
      "- Look before you move: on every wake, first use wallet_balances, market_prices and wallet_history to review holdings, price trends and recent trades, then decide.\n- Doing nothing is the default: do not trade without a clear reason. At most one trade per wake. Do not chase gains or dump on losses within a single hour.\n- Count the costs: every trade pays gas and slippage; if the expected gain does not cover them, do not trade.\n- Write the reason before trading, and review afterwards: before a trade, use bot_note to record the reason and expectation; on the next wake, compare the outcome and write what you learned into your method documents; when you repeat the same mistake, revise your method.\n- Respect the risk controls: they are enforced in code (trade only USDC, WETH and cbBTC; each trade at most 25% of the value; slippage at most 1%; a 10% daily loss trips the breaker; trading stops when the value is below $5). When refused, do not work around the limits or split orders to evade the cap. After the breaker trips, stop trading and wait for the owner to restore it.\n- Touch only the coins in your own wallet: remitting to the owner is the system's job, not yours.\n- Set your own pace: use set_next_wake to choose when to wake next. In calm markets set it long, at most 4 hours; when you have a judgment to verify, set it short, at least 30 minutes.\n- Bother the owner rarely: ordinarily send no notifications. On your first wake, record the current value in memory as the principal baseline; update the baseline when the value clearly rises because of a deposit. Only notify the owner with notify_owner when the breaker trips, after 3 consecutive losing trades, or when the value has fallen more than 20% below the principal baseline.",
    undeletable:
      "Earning a living is its instinct, so it cannot be deleted; pause it if you want it to stop.",
  },
  error: {
    rpc: "The chain is unavailable right now; this remittance did not finish.",
    busy:
      "The previous remittance is still unconfirmed, so no new one is sent yet.",
    bad_amount: "That amount is invalid; it must be a finite positive number.",
    below_min: "That amount is below the minimum remittance.",
    insufficient: "The on-chain balance is too low.",
    unconfigured: "The wallet is not configured.",
    reverted: "This transaction reverted on chain.",
    abandoned: "This remittance was interrupted before it was signed.",
    replaced:
      "Another transaction with the same nonce replaced this one, so it will never be mined.",
    stuck:
      "the transfer has not reached the chain, possibly for lack of ETH for gas; top up ETH and it will be resent automatically.",
  },
  swap: {
    rpc: "The chain is unavailable right now; this swap did not go out.",
    busy: "The previous transaction is still unconfirmed, so no swap yet.",
    inFlight:
      "The swap was sent and is still waiting for confirmation; it may already have filled. Do not place another order; use wallet_history to check.",
    approve: "The approval did not confirm, so this swap did not go out.",
    ok: "Swap filled: received {amountOut} {buy}. Value {before} → {after}. Transaction: {txUrl}",
  },
  refusal: {
    not_whitelisted: "That token is not on the whitelist.",
    same_token: "The sold and bought tokens must differ.",
    no_pool: "There is no usable pool for that pair.",
    bad_amount:
      "That amount is invalid; it must be a positive decimal within the token's precision.",
    depleted: "The wallet is worth less than $5, so trading is paused.",
    breaker:
      "The breaker is tripped: realized losses in the window have reached 10% of the value, so trading is paused.",
    gas_low: "The wallet lacks ETH for gas; top up a little ETH.",
    insufficient: "The balance of that token is too low.",
    too_large: "One trade cannot exceed 25% of the wallet's total value.",
  },
  notice: {
    remit:
      "Sent {usdc} to your address. Transaction: {txUrl} (remittance {id}). Tell me once you have topped up and I will book it.",
    remitShort: "That leaves {short} short of what was needed.",
    failed:
      "The {usdc} remittance did not go out: {reason} It will be tried again on the next tier change.",
    tradeStuck:
      "A swap has not reached the chain, possibly for lack of ETH for gas; top up ETH and it will be resent automatically.",
    depleted:
      "The wallet is now worth {value}, below $5, so the earner bot has stopped trading. Top up the wallet and it will resume automatically.",
  },
};
