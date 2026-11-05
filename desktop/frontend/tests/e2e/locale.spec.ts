import { expect, test } from "@playwright/test";

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
