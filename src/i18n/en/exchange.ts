import type { Messages } from "../messages";

export const exchange: Messages["exchange"] = {
  error: {
    region:
      "Binance rejects this Worker's egress as a restricted location; set a non-US baseUrl proxy for this account",
    unknownKey: "This venue does not accept the API key; check or regenerate it",
    wrongDomain:
      "OKX says this key does not belong to this domain: baseUrl must match the site that issued it",
    signature: "The signature is wrong; usually the secret",
    timestamp: "The venue rejected the timestamp as expired",
    passphrase: "The OKX passphrase is wrong",
    rate: "The venue is rate limiting; retry in a minute",
    timeout: "The venue was too slow; nothing was read this time",
    network: "Could not reach the venue; check baseUrl and the network",
    parse: "The venue returned an unexpected payload",
    refused:
      "The venue refused this query (product disabled or account mode unsupported)",
    account: "There is no exchange account named {id}",
    syncUnsupported: "Only Binance accounts can be synced from the desktop",
    invalidSync: "The desktop sent a malformed snapshot",
  },
  progress: {
    assets: "Check assets: {account}",
    all: "Check assets: all accounts",
  },
  section: {
    title: "Exchange accounts: {accounts}",
    rules:
      "Read-only: balances and positions. Never place, cancel, transfer or withdraw.",
    omitted:
      "Every account is checked when none is named. Values are in USDT; OKX USD figures are shown 1:1 as USD≈USDT.",
    synced:
      "Binance figures may come from the desktop sync; keep the source and age in your answer.",
  },
  bucket: {
    spot: "spot",
    funding: "funding",
    margin: "margin",
    futures: "futures",
    earn: "earn",
  },
  position: {
    long: "long",
    short: "short",
    entry: "entry",
    mark: "mark",
    upl: "uPnL",
    liq: "liq",
  },
  part: {
    funding: "Funding",
    margin: "Margin",
    futures: "Futures",
    earn: "Earn",
    positions: "Positions",
    valuation: "Valuation",
  },
  result: {
    empty: "No non-zero balances on these accounts",
    cached: "Data from {seconds}s ago",
    total: "Total ≈ {total} USDT ({parts})",
    accountTotal: "Total ≈ {total} USDT",
    skipped: "{account}: skipped ({reason})",
    degraded: "{part}: unavailable ({reason})",
    merged: "OKX margin lives inside the trading account",
    folded: "{count} more under {min} USDT, {total} together",
    truncated: "{count} more currencies not shown",
    accountsLeft: "{count} more accounts not shown; query one with the account parameter",
    overCap: "{count} more accounts not checked (8 per call): {list}",
    allFailed: "All {count} accounts failed",
    positions: "Positions",
    synced: "Synced by the desktop app {minutes} min ago",
    syncedStale: "The desktop app may be closed; this may be out of date",
    syncHint: "Turn on local sync on the desktop Exchanges page",
  },
};
