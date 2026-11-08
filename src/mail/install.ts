import type { TSchema } from "@earendil-works/pi-ai";
import type {
  Extension,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { t, type Locale } from "../i18n";
import type { TaskEventBody } from "../protocol";
import { mailProgressText, mailReadTool, mailSearchTool } from "../tools/mail";
import { withProgress } from "../tools/wrap";
import { configuredAccounts, type MailAccount } from "./accounts";
import type { SocketConnect } from "./socket";

export type MailInstallDeps = {
  locale: () => Locale;
  connect?: SocketConnect;
  /** Progress sink; omitted in tests. */
  progress?: (body: TaskEventBody) => Promise<void>;
};

/** The prompt section body: which accounts exist and what the tools may do. */
export function mailSectionText(
  accounts: MailAccount[],
  locale: Locale,
): string {
  return [
    t(locale, "mail.section.title", {
      accounts: accounts
        .map((account) => `${account.id}（${account.user}）`)
        .join("、"),
    }),
    t(locale, "mail.section.rules"),
    t(locale, "mail.section.omitted"),
  ].join("\n");
}

/**
 * The `mail` extension, or null when no account is both configured and
 * complete. Tools and the prompt section travel together, so an unconfigured
 * deployment shows the model no trace of this subsystem.
 */
export function mailExtension(
  env: Env,
  deps: MailInstallDeps,
): Extension | null {
  const accounts = configuredAccounts(env);
  if (accounts.length === 0) return null;

  const toolDeps = { env, locale: deps.locale, connect: deps.connect };
  const wrap = <T extends TSchema>(
    tool: ToolRegistration<T>,
  ): ToolRegistration<T> => {
    const progress = deps.progress;
    if (progress === undefined) return tool;
    return withProgress(tool, progress, (args) =>
      mailProgressText(tool.name, args, deps.locale()),
    );
  };

  return {
    name: "mail",
    tools: [
      wrap(mailSearchTool(accounts, toolDeps)),
      wrap(mailReadTool(accounts, toolDeps)),
    ],
    sections: [
      { key: "mail", render: () => mailSectionText(accounts, deps.locale()) },
    ],
  };
}
