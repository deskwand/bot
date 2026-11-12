import { expect, test, type Page } from "@playwright/test";
import { expectNoChinese, useEnglish } from "./i18n-helpers";

test("switching to English applies at once and persists", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");

  const group = page.getByRole("group", { name: "语言" });
  await group.getByRole("button", { name: "English", exact: true }).click();

  const englishGroup = page.getByRole("group", { name: "Language" });
  await expect(englishGroup).toBeVisible();
  await expect(
    englishGroup.getByRole("button", { name: "English", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await expect(page.getByRole("group", { name: "Language" })).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Language" })
      .getByRole("button", { name: "English", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("shows the bot sync hint and syncs", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page
    .getByRole("group", { name: "语言" })
    .getByRole("button", { name: "English", exact: true })
    .click();

  const hint = page.getByText("The bot switches to English after the next publish");
  await expect(hint).toBeVisible();

  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(hint).toHaveCount(0);

  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          __mockCalls?: Record<string, unknown[][]>;
        }
      ).__mockCalls?.publishConfig,
  );
  expect(calls).toHaveLength(1);
  expect(calls?.[0]?.[0]).toEqual({ baseFingerprint: "fp-current" });
});

test("no sync hint when published locale is missing and resolved is zh", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await expect(
    page.getByRole("heading", { name: "deskwand-bot", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "语言" })).toBeVisible();
  await expect(page.getByText("下次发布后 bot 使用中文")).toHaveCount(0);
});

test("save failure still switches and warns", async ({ page }) => {
  await page.goto("/test.html?fixture=configured&localeSaveFails=1");
  await page
    .getByRole("group", { name: "语言" })
    .getByRole("button", { name: "English", exact: true })
    .click();

  await expect(page.getByRole("group", { name: "Language" })).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Language" })
      .getByRole("button", { name: "English", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Language setting was not saved; it will revert on next launch" }),
  ).toBeVisible();
});

async function chooseModel(page: Page, label: string, provider: string, model: RegExp) {
  const providerTrigger = page.getByLabel(`${label}供应商`);
  const switching = (await providerTrigger.textContent())?.trim() !== provider;
  await providerTrigger.click();
  await page.getByRole("option", { name: provider, exact: true }).click();
  if (!switching) await page.getByLabel(label, { exact: true }).click();
  await page.getByRole("listbox").getByRole("option", { name: model }).click();
}

test("switching back to system follows the system language", async ({ page }) => {
  await page.goto("/test.html?fixture=configured&locale=en");

  const englishGroup = page.getByRole("group", { name: "Language" });
  await englishGroup.getByRole("button", { name: "中文", exact: true }).click();

  const chineseGroup = page.getByRole("group", { name: "语言" });
  await chineseGroup.getByRole("button", { name: "跟随系统", exact: true }).click();

  await expect(page.getByRole("group", { name: "Language" })).toBeVisible();
});

test("sync is blocked while a page has unsaved changes", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await chooseModel(page, "管家模型", "OpenCode Go", /DeepSeek V4 Pro/);

  await page
    .getByRole("group", { name: "语言" })
    .getByRole("button", { name: "English", exact: true })
    .click();

  const sync = page.getByRole("button", { name: "Sync now", exact: true });
  await expect(sync).toBeDisabled();
  await expect(
    page.getByText("Publish or discard this page's changes first"),
  ).toBeVisible();
});

test("html lang follows the locale", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");

  await page
    .getByRole("group", { name: "语言" })
    .getByRole("button", { name: "English", exact: true })
    .click();

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("formatDateTime follows the locale", async ({ page }) => {
  // Index-based nav keeps working once the shell itself is translated.
  // The agent page was inserted between Exchanges and Services.
  const backupNav = () =>
    page.locator("#primary-nav").getByRole("button").nth(8);

  await page.goto("/test.html?fixture=backup");
  await backupNav().click();
  await expect(page.getByTestId("backup-file-list")).toContainText(
    /\d{4}\/\d{1,2}\/\d{1,2}/,
  );

  await page.goto("/test.html?fixture=backup&locale=en");
  await backupNav().click();
  await expect(page.getByTestId("backup-file-list")).toContainText(
    /\d{1,2}\/\d{1,2}\/\d{4}/,
  );
});

test("state badges switch language without reload", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByTestId("overview-status-details").locator("summary").click();

  const badge = page.getByTestId("state-model");
  await expect(badge).toHaveText("已配置");

  await page
    .getByRole("group", { name: "语言" })
    .getByRole("button", { name: "English", exact: true })
    .click();

  await expect(page.getByTestId("state-model")).toHaveText("Configured");
});

test("switching language refetches server text", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await openPage(page, "诊断");
  await expect(page.getByTestId("status-model")).toBeVisible();

  const statusCalls = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __mockCalls?: Record<string, unknown[][]>;
          }
        ).__mockCalls?.status?.length ?? 0,
    );

  const before = await statusCalls();
  await page
    .getByRole("group", { name: "语言" })
    .getByRole("button", { name: "English", exact: true })
    .click();

  await expect.poll(statusCalls).toBeGreaterThan(before);
});

test("shell is English", async ({ page }) => {
  await useEnglish(page, "/test.html?fixture=configured");
  await expectNoChinese(page, "aside");
});

async function openPage(page: Page, name: string) {
  await page
    .locator("#primary-nav")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page.locator("main h1")).toHaveText(name);
}

test("overview is English", async ({ page }) => {
  await useEnglish(page, "/test.html?fixture=configured");
  await openPage(page, "Overview");
  await page.getByTestId("overview-status-details").locator("summary").click();
  await expect(page.getByTestId("status-model")).toBeVisible();
  await expectNoChinese(page, "main");
});

test("overview todos are English", async ({ page }) => {
  await useEnglish(page, "/test.html?fixture=configured");
  await openPage(page, "Overview");
  const todo = page.getByTestId("overview-todos");
  await expect(
    todo.getByRole("button", { name: "Connect channel", exact: true }),
  ).toBeVisible();
  await expectNoChinese(page, "main");
});

test("diagnostics is English", async ({ page }) => {
  for (const fixture of ["configured", "diagnostics-unknown"]) {
    await useEnglish(page, `/test.html?fixture=${fixture}`);
    await openPage(page, "Diagnostics");
    await expectNoChinese(page, "main");
  }
});

test("updates is English", async ({ page }) => {
  for (const fixture of ["configured", "upgrade-required"]) {
    await useEnglish(page, `/test.html?fixture=${fixture}`);
    await openPage(page, "Updates");
    await expectNoChinese(page, "main");
  }
});

test("channels page is English", async ({ page }) => {
  for (const fixture of [
    "configured",
    "telegram-configured",
    "qr-expired",
    "qr-publish-failed",
    "entry-unknown",
    "user-evidence",
  ]) {
    await useEnglish(page, `/test.html?fixture=${fixture}`);
    await openPage(page, "Channels");
    await expectNoChinese(page, "main");
  }
});

test("expectNoChinese ignores marked regions", async ({ page }) => {
  await page.setContent(
    "<div>Hello<span data-i18n-ignore>中文</span></div>",
  );
  await expectNoChinese(page);

  await page.setContent("<div>中文</div>");
  await expect(expectNoChinese(page)).rejects.toThrow(/Found Chinese text/);
});

test("models is English", async ({ page }) => {
  // Configured: the model picker, the custom endpoint form and the preview.
  await useEnglish(page, "/test.html?fixture=configured");
  await openPage(page, "Models");
  await expectNoChinese(page, "body");

  await page.getByLabel("Butler model provider").click();
  await page.getByRole("option", { name: "Anthropic", exact: true }).click();
  await expect(page.getByPlaceholder("Search models")).toBeVisible();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expectNoChinese(page, "body");
  await page.getByPlaceholder("Search models").fill("no-such-model");
  await expect(page.getByText("No matching models")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Add custom endpoint" }).click();
  const custom = page.getByRole("dialog", { name: "Add custom endpoint" });
  await expect(custom).toBeVisible();
  await expectNoChinese(page, "body");
  await custom.getByRole("button", { name: "Cancel" }).click();

  await page
    .getByTestId("model-key-row-opencode-go")
    .getByLabel("API key")
    .fill("sk-en-SENTINEL");
  await page.getByRole("button", { name: "Save and publish" }).click();
  await expect(
    page.getByRole("dialog", { name: "Confirm save and publish" }),
  ).toBeVisible();
  await expectNoChinese(page, "body");

  // A failed publish keeps its short line and Go detail in English layout.
  await useEnglish(page, "/test.html?fixture=model-key-missing");
  await openPage(page, "Models");
  await page
    .getByTestId("model-key-row-opencode-go")
    .getByLabel("API key")
    .fill("sk-en-SENTINEL");
  await page.getByRole("button", { name: "Save and publish" }).click();
  const preview = page.getByRole("dialog", { name: "Confirm save and publish" });
  await preview
    .getByRole("button", { name: "Confirm save and publish" })
    .click();
  await expect(page.getByTestId("error-alert")).toBeVisible();
  await expectNoChinese(page, "body");

  // A config conflict shows the reload affordance in English.
  await useEnglish(page, "/test.html?fixture=config-conflict");
  await openPage(page, "Models");
  await page
    .getByTestId("model-key-row-opencode-go")
    .getByLabel("API key")
    .fill("sk-en-SENTINEL");
  await page.getByRole("button", { name: "Save and publish" }).click();
  await expect(page.getByTestId("error-alert")).toBeVisible();
  await expectNoChinese(page, "body");
});

test("backup page is English", async ({ page }) => {
  for (const fixture of ["backup", "backup-pending"]) {
    await useEnglish(page, `/test.html?fixture=${fixture}`);
    await openPage(page, "Backup");
    await expectNoChinese(page, "main");
  }

  // The progress card while an export runs.
  await useEnglish(page, "/test.html?fixture=backup-progress");
  await openPage(page, "Backup");
  await page.getByRole("button", { name: "Back up now", exact: true }).click();
  await expect(page.getByTestId("backup-progress")).toBeVisible();
  await expectNoChinese(page, "main");

  // A version mismatch blocks restore with an English explanation.
  await useEnglish(page, "/test.html?fixture=backup-version-mismatch");
  await openPage(page, "Backup");
  await page
    .getByRole("button", { name: "Restore from file", exact: true })
    .click();
  await expect(page.getByText("Restore summary", { exact: true })).toBeVisible();
  await expectNoChinese(page, "main");

  // The overwrite confirmation dialog.
  await useEnglish(page, "/test.html?fixture=backup");
  await openPage(page, "Backup");
  await page
    .getByRole("button", { name: "Restore this one", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Overwrite and restore", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Confirm overwrite restore",
  });
  await expect(dialog).toBeVisible();
  await expectNoChinese(page, '[role="dialog"]');
});

test("setup is English", async ({ page }) => {
  await useEnglish(page, "/test.html");
  await expect(
    page.getByRole("heading", { name: "Deploy once, manage anytime." }),
  ).toBeVisible();
  await expectNoChinese(page, "body");

  await page.getByRole("button", { name: "Sign in with Cloudflare" }).click();
  await expect(
    page.getByRole("button", { name: "Deploy a new cloud service" }),
  ).toBeVisible();
  await expectNoChinese(page, "body");

  // New deployment path: form, interrupted install and the result panel.
  await page
    .getByRole("button", { name: "Deploy a new cloud service" })
    .click();
  await expectNoChinese(page, "body");
  await page.locator("#install-channel-telegram").click();
  await page.getByRole("button", { name: "Check and deploy" }).click();
  await expect(page.getByText("Deployment incomplete")).toBeVisible();
  await expectNoChinese(page, "body");
  await page.getByTestId("result-resume").click();
  await expect(
    page.getByRole("heading", {
      name: "Service deployed; set up a channel next",
    }),
  ).toBeVisible();
  await expectNoChinese(page, "body");

  // Existing deployment path: worker list, legacy preview and the result.
  await useEnglish(page, "/test.html");
  await page.getByRole("button", { name: "Sign in with Cloudflare" }).click();
  await page
    .getByRole("button", { name: "Connect an existing service" })
    .click();
  await expect(page.getByText("Connectable services")).toBeVisible();
  await expectNoChinese(page, "body");
  const legacy = page.locator("li", { hasText: "my-bot" }).first();
  await legacy.getByRole("button", { name: "Take over" }).click();
  await expect(page.getByText("Needs a compatible upgrade")).toBeVisible();
  await expectNoChinese(page, "body");
  await page
    .getByRole("button", { name: "Confirm configuration and take over" })
    .click();
  await expect(
    page.getByRole("button", { name: "Go to the dashboard" }),
  ).toBeVisible();
  await expectNoChinese(page, "body");
});

test("setup failures are English", async ({ page }) => {
  // An install that collides with an operation already in progress.
  await useEnglish(page, "/test.html?fixture=install-conflict");
  await page.getByRole("button", { name: "Sign in with Cloudflare" }).click();
  await page
    .getByRole("button", { name: "Deploy a new cloud service" })
    .click();
  await page.locator("#install-channel-telegram").click();
  await page.getByRole("button", { name: "Check and deploy" }).click();
  await expect(page.getByTestId("error-alert")).toBeVisible();
  await expectNoChinese(page, "body");

  // A takeover whose remote result is unknown, then resumed.
  await useEnglish(page, "/test.html?fixture=import-resume");
  await page.getByRole("button", { name: "Sign in with Cloudflare" }).click();
  await page
    .getByRole("button", { name: "Connect an existing service" })
    .click();
  await page
    .locator("li", { hasText: "my-bot" })
    .first()
    .getByRole("button", { name: "Take over" })
    .click();
  await page
    .getByRole("button", { name: "Confirm configuration and take over" })
    .click();
  await expect(page.getByText("Takeover incomplete")).toBeVisible();
  await expectNoChinese(page, "body");
  await page.getByTestId("result-resume").click();
  await expect(
    page.getByRole("button", { name: "Go to the dashboard" }),
  ).toBeVisible();
  await expectNoChinese(page, "body");

  // A takeover that still contains plaintext credentials.
  await useEnglish(page, "/test.html?fixture=import-secret-retry");
  await page.getByRole("button", { name: "Sign in with Cloudflare" }).click();
  await page
    .getByRole("button", { name: "Connect an existing service" })
    .click();
  await page
    .locator("li", { hasText: "my-bot" })
    .first()
    .getByRole("button", { name: "Take over" })
    .click();
  await page
    .getByRole("button", { name: "Confirm configuration and take over" })
    .click();
  await expect(page.getByTestId("error-alert")).toBeVisible();
  await expectNoChinese(page, "body");

  // The account picker and an unavailable credential store.
  await useEnglish(page, "/test.html?fixture=multi-account");
  await page.getByRole("button", { name: "Sign in with Cloudflare" }).click();
  await expect(page.getByText(/several accounts/)).toBeVisible();
  await expectNoChinese(page, "body");
  await page.getByRole("radio", { name: "第二个账户" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Deploy a new cloud service" }),
  ).toBeVisible();
  await expectNoChinese(page, "body");

  await useEnglish(page, "/test.html?fixture=store-unavailable");
  await expect(
    page.getByRole("heading", { name: "Deploy once, manage anytime." }),
  ).toBeVisible();
  await expect(page.getByTestId("error-alert")).toBeVisible();
  await expectNoChinese(page, "body");
});

test("language can be chosen before connecting", async ({ page }) => {
  await page.goto("/test.html");

  const group = page.getByRole("group", { name: "语言" });
  await expect(group).toBeVisible();
  await group.getByRole("button", { name: "English", exact: true }).click();

  await expect(page.getByRole("group", { name: "Language" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Deploy once, manage anytime." }),
  ).toBeVisible();
});

test("connection errors follow a language switch", async ({ page }) => {
  await page.goto("/test.html?fixture=store-unavailable");
  await page
    .getByRole("group", { name: "语言" })
    .getByRole("button", { name: "English", exact: true })
    .click();

  const alert = page.getByTestId("error-alert");
  await expect(alert).toBeVisible();
  await alert.locator("summary").click();
  await expect(alert).toContainText("Keychain unavailable");
  await expectNoChinese(page, '[data-testid="error-alert"]');
});

test("switching language mid-setup keeps inputs", async ({ page }) => {
  await page.goto("/test.html");
  await page.getByRole("button", { name: "使用 Cloudflare 登录" }).click();
  await page.getByRole("button", { name: "部署新服务" }).click();
  await page.getByText("资源设置", { exact: true }).click();
  await page.getByLabel("服务名称").fill("my-worker");

  await page
    .getByRole("group", { name: "语言" })
    .getByRole("button", { name: "English", exact: true })
    .click();

  await expect(
    page.getByRole("heading", { name: "Deploy a new cloud service" }),
  ).toBeVisible();
  await expect(page.getByLabel("Service name")).toHaveValue("my-worker");
});

test("dialogs are English", async ({ page }) => {
  await useEnglish(page, "/test.html?fixture=upgrade-required");
  await openPage(page, "Updates");
  await page.getByTestId("upgrade-cloud").click();
  const upgrade = page.getByRole("dialog", { name: "Confirm upgrade" });
  await expect(upgrade).toBeVisible();
  await expectNoChinese(page, '[role="dialog"]');
  await upgrade.getByRole("button", { name: "Cancel" }).click();

  await useEnglish(page, "/test.html?fixture=configured");
  await openPage(page, "Models");
  const row = page.getByTestId("model-key-row-opencode-go");
  await row.getByLabel("API key").fill("sk-en-SENTINEL");
  await row.getByRole("button", { name: "Test connection" }).click();
  const probe = page.getByRole("dialog", { name: "Run the model connection test?" });
  await expect(probe).toBeVisible();
  await expectNoChinese(page, '[role="dialog"]');
  await probe.getByRole("button", { name: "Cancel" }).click();

  // The draft key makes the page dirty, so switching pages asks first.
  await page.locator("#primary-nav").getByRole("button", { name: "Overview", exact: true }).click();
  const unsaved = page.getByRole("dialog", { name: "Unsaved changes" });
  await expect(unsaved).toBeVisible();
  await expectNoChinese(page, '[role="dialog"]');
  await unsaved.getByRole("button", { name: "Keep editing" }).click();

  await page.locator("aside").getByRole("button", { name: "Sign out" }).click();
  const signOut = page.getByRole("dialog", { name: "Sign out of Cloudflare?" });
  await expect(signOut).toBeVisible();
  await expectNoChinese(page, '[role="dialog"]');
  await signOut.getByRole("button", { name: "Cancel" }).click();

  await useEnglish(page, "/test.html?fixture=backup-pending");
  await page.getByRole("button", { name: "Abandon record" }).click();
  const abandonRestore = page.getByRole("dialog", {
    name: "Abandon the unfinished restore record?",
  });
  await expect(abandonRestore).toBeVisible();
  await expectNoChinese(page, '[role="dialog"]');
  await abandonRestore.getByRole("button", { name: "Cancel" }).click();

  await useEnglish(page, "/test.html?fixture=configured");
  await openPage(page, "Channels");
  await page.getByRole("button", { name: "Scan to connect" }).click();
  const qrDialog = page.getByRole("dialog", { name: "Connect WeChat" });
  await expect(qrDialog).toBeVisible();
  await expect(page.getByTestId("wechat-qr")).toBeVisible();
  await expectNoChinese(page, '[role="dialog"]');

  await useEnglish(page, "/test.html?fixture=pending-operations");
  const pending = page.getByTestId("pending-operations");
  await expect(pending).toBeVisible();
  await pending.getByRole("button", { name: "Abandon", exact: true }).click();
  const abandonOperation = page.getByRole("dialog", {
    name: "Abandon this operation?",
  });
  await expect(abandonOperation).toBeVisible();
  await expectNoChinese(page, '[role="dialog"]');
});

test("pending cards are English", async ({ page }) => {
  await useEnglish(page, "/test.html?fixture=pending-operations");
  await expect(page.getByTestId("pending-operations")).toBeVisible();
  await expectNoChinese(page, "main");

  await useEnglish(page, "/test.html?fixture=backup-pending");
  await expect(page.getByText("Data restore did not finish")).toBeVisible();
  await expectNoChinese(page, "main");
});

test("messages follow a language switch", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page
    .getByTestId("model-key-row-opencode-go")
    .getByLabel("API 密钥")
    .fill("sk-switch-SENTINEL");
  await page.getByRole("button", { name: "保存并发布" }).click();
  await page
    .getByRole("dialog", { name: "确认保存并发布" })
    .getByRole("button", { name: "确认保存并发布" })
    .click();
  await expect(page.getByText("配置已发布。", { exact: true })).toBeVisible();

  await page
    .getByRole("group", { name: "语言" })
    .getByRole("button", { name: "English", exact: true })
    .click();
  await expect(
    page.getByText("Configuration published.", { exact: true }),
  ).toBeVisible();
});

test("English shell fits the narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 600 });
  await useEnglish(page, "/test.html?fixture=configured");

  const navToggle = page.getByRole("button", { name: "Open navigation" });

  for (const name of [
    "Overview",
    "Models",
    "Services",
    "Channels",
    "Diagnostics",
    "Backup",
    "Updates",
  ]) {
    if (await navToggle.isVisible()) await navToggle.click();
    await openPage(page, name);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `${name} overflows the narrow window`,
    ).toBe(true);
    await expectNoChinese(page, "aside");
  }
});
