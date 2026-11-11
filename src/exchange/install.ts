import type { Extension } from "@earendil-works/pi-durable";
import { t, type Locale } from "../i18n";
import type { TaskEventBody } from "../protocol";
import { exchangeAssetsTool, exchangeProgressText } from "../tools/exchange";
import { withProgress } from "../tools/wrap";
import { configuredAccounts } from "./accounts";
import { binanceAdapter } from "./binance";
import { createSnapshotCache } from "./cache";
import { okxAdapter } from "./okx";
import type { ExchangeAccount } from "./types";

export type ExchangeInstallDeps = {
  locale: () => Locale;
  /** Progress sink; omitted in tests. */
  progress?: (body: TaskEventBody) => Promise<void>;
};

/** The prompt section body: which accounts exist and what the tool may do. */
export function exchangeSectionText(
  accounts: ExchangeAccount[],
  locale: Locale,
): string {
  return [
    t(locale, "exchange.section.title", {
      accounts: accounts
        .map((account) => `${account.label}（${account.id}）`)
        .join("、"),
    }),
    t(locale, "exchange.section.rules"),
    t(locale, "exchange.section.omitted"),
  ].join("\n");
}

/**
 * The `exchange` extension, or null when no account is both configured and
 * complete. Tools and the prompt section travel together, so an unconfigured
 * deployment shows the model no trace of this subsystem.
 */
export function exchangeExtension(
  env: Env,
  deps: ExchangeInstallDeps,
): Extension | null {
  const accounts = configuredAccounts(env);
  if (accounts.length === 0) return null;

  const tool = exchangeAssetsTool(accounts, {
    locale: deps.locale,
    adapters: { okx: okxAdapter, binance: binanceAdapter },
    cache: createSnapshotCache(),
  });
  const wrapped =
    deps.progress === undefined
      ? tool
      : withProgress(tool, deps.progress, (args) =>
          exchangeProgressText(args, deps.locale()),
        );

  return {
    name: "exchange",
    tools: [wrapped],
    sections: [
      {
        key: "exchange",
        render: () => exchangeSectionText(accounts, deps.locale()),
      },
    ],
  };
}
