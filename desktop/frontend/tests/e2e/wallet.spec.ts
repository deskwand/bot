import { expect, test, type Page } from "@playwright/test";
import { expectNoChinese, useEnglish } from "./i18n-helpers";

const PRIVATE_KEY = `0x${"1".repeat(64)}`;
const OWNER_ADDRESS = `0x${"2".repeat(40)}`;
const WALLET_ADDRESS = `0x${"ab".repeat(20)}`;

type WalletSave = {
  privateKey?: string;
  ownerAddress?: string;
  rpcUrl?: string;
};

async function openWallet(page: Page, scenario: string) {
  await page.goto(`/test.html?fixture=${scenario}`);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "钱包", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "钱包", exact: true }),
  ).toBeVisible();
}

async function saves(page: Page): Promise<WalletSave[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __walletCalls: { saves: WalletSave[] };
        }
      ).__walletCalls.saves,
  );
}

test("blocks saving while every field is empty", async ({ page }) => {
  await openWallet(page, "wallet-unconfigured");

  await expect(page.getByTestId("wallet-status")).toHaveText("未配置");
  await expect(page.getByRole("button", { name: "保存并部署" })).toBeDisabled();
});

test("blocks saving when the private key is not 32 bytes of hex", async ({
  page,
}) => {
  await openWallet(page, "wallet-unconfigured");

  await page.getByLabel("私钥", { exact: true }).fill("0x1234");

  await expect(
    page.getByText("私钥必须是 0x 开头的 64 位十六进制"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "保存并部署" })).toBeDisabled();
});

test("saves the wallet and then shows it as configured", async ({ page }) => {
  await openWallet(page, "wallet-unconfigured");

  await page.getByLabel("私钥", { exact: true }).fill(PRIVATE_KEY);
  await page.getByLabel("收款地址", { exact: true }).fill(OWNER_ADDRESS);
  await page.getByRole("button", { name: "保存并部署" }).click();

  await expect.poll(async () => (await saves(page)).length).toBe(1);
  expect((await saves(page))[0]).toEqual({
    privateKey: PRIVATE_KEY,
    ownerAddress: OWNER_ADDRESS,
  });
  await expect(page.getByTestId("wallet-status")).toHaveText("已配置");
  await expect(page.getByTestId("wallet-address")).toHaveText(WALLET_ADDRESS);
  await expect(page.getByTestId("wallet-value")).toContainText("12.50");
  // The write-only key is cleared after a successful save and never echoed.
  await expect(page.getByLabel("私钥", { exact: true })).toHaveValue("");
  await expect(page.locator("body")).not.toContainText(PRIVATE_KEY);
});

test("shows the address and valuation of a configured wallet", async ({
  page,
}) => {
  await openWallet(page, "wallet-configured");

  await expect(page.getByTestId("wallet-status")).toHaveText("已配置");
  await expect(page.getByTestId("wallet-address")).toHaveText(WALLET_ADDRESS);
  await expect(page.getByTestId("wallet-value")).toContainText("12.50");
  await expect(page.getByLabel("私钥", { exact: true })).toHaveValue("");
});

test("says the valuation is unavailable when the Worker omits it", async ({
  page,
}) => {
  await openWallet(page, "wallet-unavailable");

  await expect(page.getByTestId("wallet-address")).toHaveText(WALLET_ADDRESS);
  await expect(page.getByTestId("wallet-value")).toHaveText("暂不可用");
});

test("treats zero as a real valuation", async ({ page }) => {
  await openWallet(page, "wallet-zero");

  await expect(page.getByTestId("wallet-value")).toContainText("0.00");
  await expect(page.getByTestId("wallet-value")).not.toContainText("暂不可用");
});

test("english has no chinese", async ({ page }) => {
  await useEnglish(page, "/test.html?fixture=wallet-configured");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Wallet", exact: true })
    .click();
  await expectNoChinese(page);
});
