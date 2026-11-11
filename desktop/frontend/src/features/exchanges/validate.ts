import type { ExchangeAccountDTO } from "@/services/types";
import { venueOption } from "./providers";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type AccountProblem = {
  index: number;
  field: "id" | "venue" | "baseUrl" | "label";
  key: string;
};

function validBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  try {
    const url = new URL(trimmed);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.pathname === "" || url.pathname === "/") &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** Same rules as src/exchange/accounts.ts, reported per row. */
export function accountProblems(
  accounts: readonly ExchangeAccountDTO[],
): AccountProblem[] {
  const problems: AccountProblem[] = [];
  const seen = new Set<string>();
  accounts.forEach((account, index) => {
    if (!ID.test(account.id)) {
      problems.push({ index, field: "id", key: "exchange.problemId" });
    } else if (seen.has(account.id)) {
      problems.push({ index, field: "id", key: "exchange.problemDuplicate" });
    }
    seen.add(account.id);
    if (venueOption(account.venue) === undefined) {
      problems.push({ index, field: "venue", key: "exchange.problemVenue" });
    }
    if (!validBaseUrl(account.baseUrl ?? "")) {
      problems.push({ index, field: "baseUrl", key: "exchange.problemBaseUrl" });
    }
    if ((account.label ?? "").length > 64) {
      problems.push({ index, field: "label", key: "exchange.problemLabel" });
    }
  });
  return problems;
}
