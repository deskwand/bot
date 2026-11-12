import type { Messages } from "../types";

export const wallet: Messages["wallet"] = {
  intro:
    "The agent is an individual of its own. Configure what belongs to it here, and what it has agreed with you.",
  status: "Wallet status",
  loading: "Reading the wallet status…",
  configured: "Configured",
  notConfigured: "Not configured",
  missing: "Still missing: {items}",
  missingSeparator: ", ",
  missingPrivateKey: "the agent's private key",
  missingOwnerAddress: "your payout address",
  missingStillInactive:
    "Both are set, but the wallet is still not active: check the private key and the payout address; the payout address cannot be the agent's own address.",
  set: "Set",
  notSet: "Not set",
  agentWalletTitle: "The agent's wallet",
  walletAddress: "Wallet address",
  walletAddressHint: "Send USDC here as principal, plus a little ETH for gas.",
  value: "Total value",
  valueUnavailable: "Temporarily unavailable",
  privateKey: "The agent's private key",
  privateKeyHint:
    "Generate a fresh key just for the agent; do not enter your own wallet's key. 0x followed by 64 hexadecimal characters; write-only, cleared after saving.",
  keyPlaceholderConfigured: "Configured; enter a new value to replace it",
  keyPlaceholderNew: "Enter the private key",
  advanced: "Advanced",
  rpcUrl: "RPC URL (optional)",
  rpcUrlHint: "Leave empty for https://mainnet.base.org; must be an https URL.",
  rpcUrlPlaceholder: "https://mainnet.base.org",
  ownerTitle: "You (the owner)",
  ownerAddress: "Your payout address",
  ownerAddressHint:
    "Your own wallet's address. Everything the agent sends you, including remittances when its ledger runs low, goes only here; it cannot be the agent's own address. 0x followed by 40 hexadecimal characters.",
  ownerAddressPlaceholder: "0x…",
  problemPrivateKey:
    "The private key must be 0x followed by 64 hexadecimal characters",
  problemOwnerAddress:
    "The payout address must be 0x followed by 40 hexadecimal characters",
  problemOwnerIsAgent: "The payout address cannot be the agent's own address",
  problemRpcUrl: "The RPC URL must be an https URL",
  unchangedKept: "Fields left empty stay unchanged.",
  keysNeverEchoed: "Keys are never echoed",
  saved: "Saved and deployed.",
  save: "Save and deploy",
  saving: "Saving…",
  reload: "Refresh status",
};
