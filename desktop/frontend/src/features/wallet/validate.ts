export type WalletDraft = {
  privateKey: string;
  ownerAddress: string;
  rpcUrl: string;
};

export type WalletProblem = "privateKey" | "ownerAddress" | "rpcUrl";

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function walletDraftEmpty(draft: WalletDraft): boolean {
  return (
    draft.privateKey.trim() === "" &&
    draft.ownerAddress.trim() === "" &&
    draft.rpcUrl.trim() === ""
  );
}

function validRPCUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** Same formats the Go save checks; the Worker still checks the checksum. */
export function walletProblems(draft: WalletDraft): WalletProblem[] {
  const problems: WalletProblem[] = [];
  const privateKey = draft.privateKey.trim();
  if (privateKey !== "" && !PRIVATE_KEY.test(privateKey)) {
    problems.push("privateKey");
  }
  const ownerAddress = draft.ownerAddress.trim();
  if (ownerAddress !== "" && !ADDRESS.test(ownerAddress)) {
    problems.push("ownerAddress");
  }
  const rpcUrl = draft.rpcUrl.trim();
  if (rpcUrl !== "" && !validRPCUrl(rpcUrl)) {
    problems.push("rpcUrl");
  }
  return problems;
}
