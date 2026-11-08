import { describe, expect, it } from "vitest";
import {
  configuredAccounts,
  resolveAccount,
  secretName,
} from "../../src/mail/accounts";
import { t } from "../../src/i18n";

function envWith(config: unknown, secrets: Record<string, string> = {}): Env {
  return { DESKWAND_CONFIG: config, ...secrets } as unknown as Env;
}

const base = {
  schemaVersion: 1,
  owner: { telegramUserIds: [] },
  models: {
    butler: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
    task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
  },
  mcpServers: [],
};

const account = {
  id: "main",
  user: "me@example.com",
  imap: { host: "imap.example.com", port: 993, security: "tls" },
};

describe("configuredAccounts", () => {
  it("returns the account when the secret is set", () => {
    expect(
      configuredAccounts(
        envWith({ ...base, email: { accounts: [account] } }, {
          EMAIL_SECRET_MAIN: "pw",
        }),
      ),
    ).toEqual([{ ...account }]);
  });

  it("drops an account whose secret is missing", () => {
    expect(
      configuredAccounts(envWith({ ...base, email: { accounts: [account] } })),
    ).toEqual([]);
  });

  it("drops an account with an out-of-range port but keeps the good one", () => {
    const bad = { ...account, id: "bad", imap: { ...account.imap, port: 70000 } };
    const accounts = configuredAccounts(
      envWith({ ...base, email: { accounts: [bad, account] } }, {
        EMAIL_SECRET_BAD: "pw",
        EMAIL_SECRET_MAIN: "pw",
      }),
    );
    expect(accounts.map((entry) => entry.id)).toEqual(["main"]);
  });

  it("returns an empty list when the section is absent or unreadable", () => {
    expect(configuredAccounts(envWith(base))).toEqual([]);
    expect(
      configuredAccounts({ DESKWAND_CONFIG: undefined } as unknown as Env),
    ).toEqual([]);
  });
});

describe("resolveAccount", () => {
  const accounts = [
    {
      id: "main",
      user: "a@example.com",
      imap: { host: "h", port: 993, security: "tls" as const },
    },
    {
      id: "work",
      user: "b@example.com",
      imap: { host: "h", port: 993, security: "tls" as const },
    },
  ];

  it("defaults to the first configured account", () => {
    expect(resolveAccount(accounts)?.id).toBe("main");
  });

  it("returns null for an unknown id", () => {
    expect(resolveAccount(accounts, "nope")).toBeNull();
  });
});

describe("secretName", () => {
  it("upper-cases and maps dashes", () => {
    expect(secretName("main-box")).toBe("EMAIL_SECRET_MAIN_BOX");
  });
});

describe("mail copy", () => {
  it("has both locales", () => {
    expect(t("zh", "mail.error.auth")).toContain("授权码");
    expect(t("en", "mail.error.auth")).not.toBe(t("zh", "mail.error.auth"));
  });
});
