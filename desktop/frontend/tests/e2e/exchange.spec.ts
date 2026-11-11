import { expect, test, type Page } from "@playwright/test";
import { expectNoChinese, useEnglish } from "./i18n-helpers";

type Published = {
  baseFingerprint?: string;
  exchangeAccounts?: { id: string; venue: string; label?: string; baseUrl?: string }[];
  secrets?: { name: string; operation: string; value?: string }[];
};

async function openExchanges(page: Page, scenario = "exchange-okx") {
  await page.goto(`/test.html?fixture=${scenario}`);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "交易所", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "交易所", exact: true }),
  ).toBeVisible();
}

async function publishes(page: Page): Promise<Published[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __configCalls: { publish: Published[] };
        }
      ).__configCalls.publish,
  );
}

test("sends the three OKX secret fields as one JSON secret", async ({ page }) => {
  await openExchanges(page);

  await page.getByLabel("API key").fill("ok-key");
  await page.getByLabel("API secret").fill("ok-secret");
  await page.getByLabel("Passphrase").fill("ok-pass");
  await page.getByRole("button", { name: "保存并部署" }).click();

  await expect.poll(async () => (await publishes(page)).length).toBe(1);
  const call = (await publishes(page))[0]!;
  // Only secrets changed, so the account array is not rewritten.
  expect(call.exchangeAccounts).toBeUndefined();
  expect(call.secrets).toHaveLength(1);
  expect(call.secrets![0]!.name).toBe("EXCHANGE_SECRET_OKX_MAIN");
  expect(JSON.parse(call.secrets![0]!.value ?? "{}")).toEqual({
    key: "ok-key",
    secret: "ok-secret",
    passphrase: "ok-pass",
  });
});

test("sends the account list when a field changes", async ({ page }) => {
  await openExchanges(page);

  await page.getByLabel("显示名称").fill("主号");
  await page.getByRole("button", { name: "保存并部署" }).click();

  await expect.poll(async () => (await publishes(page)).length).toBe(1);
  const call = (await publishes(page))[0]!;
  expect(call.exchangeAccounts).toEqual([
    { id: "okx-main", venue: "okx", label: "主号" },
  ]);
  expect(call.secrets ?? []).toEqual([]);
});

test("blocks saving when the passphrase is missing", async ({ page }) => {
  await openExchanges(page);

  await page.getByLabel("API key").fill("ok-key");
  await page.getByLabel("API secret").fill("ok-secret");
  await expect(
    page.getByText("密钥没填完：这个平台的必填项都填上才会保存"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "保存并部署" })).toBeDisabled();
});

test("tests the connection and shows the venue total", async ({ page }) => {
  await openExchanges(page);

  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByTestId("exchange-probe-0")).toContainText("连通");
  await expect(page.getByTestId("exchange-probe-0")).toContainText("12.50");
});

test("surfaces a restricted location as a refusal", async ({ page }) => {
  await openExchanges(page, "exchange-refused");

  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByTestId("exchange-probe-0")).toContainText("测试失败");
  await expect(page.getByTestId("exchange-probe-0")).toContainText("restricted");
});

test("rejects an uppercase account id before publishing", async ({ page }) => {
  await openExchanges(page);

  await page.getByLabel("账号 id").fill("OKX-Main");
  await expect(page.getByText("账号 id 只能用小写字母、数字和 -")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存并部署" })).toBeDisabled();
});

test("english has no chinese", async ({ page }) => {
  await useEnglish(page, "/test.html?fixture=exchange-okx");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Exchanges", exact: true })
    .click();
  await expectNoChinese(page);
});

test("keeps the typed secret when the account id is fixed", async ({ page }) => {
  await openExchanges(page);

  await page.getByLabel("API key").fill("ok-key");
  await page.getByLabel("API secret").fill("ok-secret");
  await page.getByLabel("Passphrase").fill("ok-pass");
  await page.getByLabel("账号 id").fill("okx-renamed");
  await page.getByRole("button", { name: "保存并部署" }).click();

  await expect.poll(async () => (await publishes(page)).length).toBe(1);
  const call = (await publishes(page))[0]!;
  expect(call.secrets).toHaveLength(1);
  expect(call.secrets![0]!.name).toBe("EXCHANGE_SECRET_OKX_RENAMED");
  expect(JSON.parse(call.secrets![0]!.value ?? "{}")).toEqual({
    key: "ok-key",
    secret: "ok-secret",
    passphrase: "ok-pass",
  });
});

test("keeps the drafts when a publish is rejected", async ({ page }) => {
  await openExchanges(page, "config-conflict");

  await page.getByRole("button", { name: "添加账号" }).click();
  await page.getByLabel("API key").fill("draft-key");
  await page.getByLabel("API secret").fill("draft-secret");
  await page.getByLabel("Passphrase").fill("draft-pass");
  await page.getByRole("button", { name: "保存并部署" }).click();

  await expect(page.getByTestId("exchange-row-0")).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveValue("draft-key");
  await expect(page.getByLabel("API secret")).toHaveValue("draft-secret");
  await expect(page.getByLabel("Passphrase")).toHaveValue("draft-pass");
});

test("marks an account that has no secret yet", async ({ page }) => {
  await openExchanges(page, "exchange-secret-missing");

  await expect(page.getByText("未配置")).toBeVisible();
  await expect(
    page.getByText("这个账号还没有密钥，部署后机器人会忽略它"),
  ).toBeVisible();
});
