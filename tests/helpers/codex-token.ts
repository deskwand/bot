const ACCOUNT_CLAIM = {
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
};

/** A token whose payload decodes to the claims; the signature is not checked. */
export function fakeCodexToken(
  claims: Record<string, unknown> = ACCOUNT_CLAIM,
): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  return `${part({ alg: "none" })}.${part(claims)}.signature`;
}
