import { describe, expect, it } from "vitest";
import { mailExtension, mailSectionText } from "../../src/mail/install";

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

const deps = { locale: () => "zh" as const };

describe("mailExtension", () => {
  it("is not installed when no account is configured", () => {
    expect(mailExtension(envWith(base), deps)).toBeNull();
  });

  it("is not installed when the account secret is missing", () => {
    expect(
      mailExtension(envWith({ ...base, email: { accounts: [account] } }), deps),
    ).toBeNull();
  });

  it("is not installed when the deployment document is unreadable", () => {
    expect(
      mailExtension({ DESKWAND_CONFIG: "{oops" } as unknown as Env, deps),
    ).toBeNull();
  });

  it("installs both read tools and one prompt section when configured", () => {
    const ext = mailExtension(
      envWith(
        { ...base, email: { accounts: [account] } },
        { EMAIL_SECRET_MAIN: "pw" },
      ),
      deps,
    );
    expect(ext?.name).toBe("mail");
    expect(ext?.tools?.map((tool) => tool.name).sort()).toEqual([
      "mail_read",
      "mail_search",
    ]);
    expect(ext?.sections?.map((section) => section.key)).toEqual(["mail"]);
  });

  it("names the account in the prompt section", () => {
    const rendered = mailSectionText(
      [
        {
          id: "main",
          user: "me@example.com",
          imap: { host: "imap.example.com", port: 993, security: "tls" },
        },
      ],
      "zh",
    );
    expect(rendered).toContain("main");
    expect(rendered).toContain("me@example.com");
  });
});

describe("mailSectionText", () => {
  it("promises only what P1 can do", () => {
    const rendered = mailSectionText(
      [
        {
          id: "main",
          user: "me@example.com",
          imap: { host: "imap.example.com", port: 993, security: "tls" },
        },
      ],
      "zh",
    );
    // P2 adds attachments delivery and replies; until then the section must
    // not tell the model it can fetch them.
    expect(rendered).not.toContain("取附件");
    expect(rendered).toContain("看附件清单");
  });
});
