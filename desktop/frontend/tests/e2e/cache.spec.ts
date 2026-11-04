import { expect, test } from "@playwright/test";

test("boot shows shell quickly while cloud is slow", async ({ page }) => {
  await page.goto("/test.html?fixture=cloud-slow");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible({ timeout: 500 });
});

test("account mismatch goes to deployment choice", async ({ page }) => {
  await page.goto("/test.html?fixture=target-other-account");
  await expect(page.getByRole("button", { name: "部署新服务" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
});

test("sign out clears cached data", async ({ page }) => {
  await page.goto("/test.html?fixture=cloud-slow");
  await expect(
    page.getByRole("heading", { name: "deskwand-bot", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "退出登录" }).click();
  await page
    .getByRole("dialog", { name: "退出 Cloudflare 账号？" })
    .getByRole("button", { name: "确认退出" })
    .click();
  await expect(page.getByRole("button", { name: "使用 Cloudflare 登录" })).toBeVisible();

  await page.getByRole("button", { name: "使用 Cloudflare 登录" }).click();
  await page.getByRole("radio", { name: "第二个账户" }).click();
  await page.getByRole("button", { name: "继续" }).click();

  // The previous target belongs to the old account, so the app must ask for a
  // new deployment instead of showing the previous account's cached overview.
  await expect(page.getByRole("button", { name: "部署新服务" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "deskwand-bot", exact: true }),
  ).toHaveCount(0);
});

test("a failing boot state reports the reason", async ({ page }) => {
  await page.goto("/test.html?fixture=boot-failed");
  const alert = page.getByTestId("error-alert");
  await expect(alert).toBeVisible();
  await alert.locator("summary").click();
  await expect(alert.getByText("SERVICE_UNAVAILABLE")).toBeVisible();
});
