import type { Messages } from "../messages";

export const wallet: Messages["wallet"] = {
  status: {
    title: "Wallet",
    address: "Address: {address}",
    holdings: "Holdings: {holdings}",
    holding: "{token} {amount}",
    noHoldings: "Holdings: none",
    value: "Total value: {value}",
    pending: "Pending remittance: {id} ({usdc})",
    noPending: "Pending remittance: none",
  },
  vitals: {
    unavailable: "Wallet: unavailable",
  },
  prompt: {
    value: "Wallet value: {value}",
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
  notice: {
    remit:
      "Sent {usdc} to your address. Transaction: {txUrl} (remittance {id}). Tell me once you have topped up and I will book it.",
    remitShort: "That leaves {short} short of what was needed.",
    failed:
      "The {usdc} remittance did not go out: {reason} It will be tried again on the next tier change.",
  },
};
