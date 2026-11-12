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
    exists: "An earner bot already exists; each deployment can have only one.",
    defaultRules:
      "Grow the wallet's value over the long run and protect the principal. Risk limits are enforced in code: trade only USDC, WETH and cbBTC; keep each trade at or below 25% of the value; keep slippage at or below 1%; a 10% daily realized loss trips the breaker; and trading stops below $5. Each wake, check holdings and prices before deciding whether to trade; doing nothing is a valid choice.",
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
