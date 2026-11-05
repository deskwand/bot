import { expect, test, type Page } from "@playwright/test";
import { expectNoChinese } from "./i18n-helpers";

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
  const backupNav = () =>
    page.locator("#primary-nav").getByRole("button").nth(5);

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

test("expectNoChinese ignores marked regions", async ({ page }) => {
  await page.setContent(
    "<div>Hello<span data-i18n-ignore>中文</span></div>",
  );
  await expectNoChinese(page);

  await page.setContent("<div>中文</div>");
  await expect(expectNoChinese(page)).rejects.toThrow(/Found Chinese text/);
});
