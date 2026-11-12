import type { Messages } from "../types";

export const wallet: Messages["wallet"] = {
  intro:
    "Configure the wallet on Base. The private key is written to Cloudflare and never echoed; the address is derived from it, and you can send USDC and gas there.",
  status: "Wallet status",
  loading: "Reading the wallet status…",
  configured: "Configured",
  notConfigured: "Not configured",
  walletAddress: "Wallet address",
  walletAddressHint: "Send USDC here for principal and gas.",
  value: "Total value",
  valueUnavailable: "Temporarily unavailable",
  privateKey: "Private key",
  privateKeyHint:
    "0x followed by 64 hexadecimal characters. Write-only; cleared after saving.",
  keyPlaceholderConfigured: "Configured; enter a new value to replace it",
  keyPlaceholderNew: "Enter the private key",
  ownerAddress: "Payout address",
  ownerAddressHint:
    "0x followed by 40 hexadecimal characters. Automatic remittances go only here.",
  ownerAddressPlaceholder: "0x…",
  rpcUrl: "RPC URL (optional)",
  rpcUrlHint: "Leave empty for https://mainnet.base.org; must be an https URL.",
  rpcUrlPlaceholder: "https://mainnet.base.org",
  problemPrivateKey:
    "The private key must be 0x followed by 64 hexadecimal characters",
  problemOwnerAddress:
    "The payout address must be 0x followed by 40 hexadecimal characters",
  problemRpcUrl: "The RPC URL must be an https URL",
  unchangedKept: "Fields left empty stay unchanged.",
  keysNeverEchoed: "Keys are never echoed",
  saved: "Saved and deployed.",
  save: "Save and deploy",
  saving: "Saving…",
  reload: "Refresh status",
};
