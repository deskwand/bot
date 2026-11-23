import { expect, test, type Page } from "@playwright/test";

/**
 * The users page is not the default route: every case clicks the sidebar entry
 * first, the way bots.spec.ts and friends reach other pages.
 */
async function openChannels(page: Page, fixture: string, label = "通道") {
  await page.goto(`/test.html?fixture=${fixture}`);
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByTestId("users-page")).toBeVisible();
}

test("lists the owner next to its users and leaves revoked rows read-only", async ({
  page,
}) => {
  await openChannels(page, "users-three");
  await expect(page.getByTestId("user-row-owner")).toContainText("运行中");
  await expect(page.getByTestId("user-row-m1")).toContainText("运行中");
  await expect(page.getByTestId("user-row-m2")).toContainText("已撤销");
  await expect(page.getByTestId("revoke-m2")).toHaveCount(0);
  await expect(page.getByTestId("revoke-owner")).toHaveCount(0);
});

test("explains an empty directory", async ({ page }) => {
  await openChannels(page, "users-empty");
  await expect(page.getByTestId("user-row-owner")).toHaveCount(0);
});

test("asks to upgrade a deployment without the member API", async ({ page }) => {
  await openChannels(page, "users-unsupported");
  await expect(page.getByTestId("users-unsupported")).toBeVisible();
});

test("walks the wizard from the real-name code to the done state", async ({
  page,
}) => {
  await openChannels(page, "users-wizard");
  await page.getByRole("button", { name: "添加用户" }).click();
  await page.getByTestId("label-input").fill("小王");
  await page.getByTestId("create-invite").click();

  await expect(page.getByTestId("qr-realname")).toBeVisible();
  await expect(page.getByTestId("realname-countdown")).toContainText("分钟");

  await page.clock.runFor(2_100);
  await expect(page.getByTestId("qr-bind")).toBeVisible();

  await page.clock.runFor(2_100);
  await expect(page.getByTestId("pin-input")).toBeVisible();

  await page.clock.runFor(2_100);
  await expect(page.getByTestId("wizard-done")).toBeVisible();
});

test("a dead invite can be restarted from the label step", async ({ page }) => {
  await openChannels(page, "users-wizard-expired");
  await page.getByRole("button", { name: "添加用户" }).click();
  await page.getByTestId("label-input").fill("小宝");
  await page.getByTestId("create-invite").click();
  await expect(page.getByTestId("wizard-dead")).toBeVisible();

  await page.getByRole("button", { name: "重新发起" }).click();
  // The trap this guards: the dialog used to re-adopt the same dead invite.
  await expect(page.getByTestId("label-input")).toBeVisible();
  await expect(page.getByTestId("wizard-dead")).toHaveCount(0);
});
