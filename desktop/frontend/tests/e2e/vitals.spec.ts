import { expect, test, type Page } from "@playwright/test";
import { expectNoChinese, useEnglish } from "./i18n-helpers";

async function mockCallCount(page: Page, name: string) {
  return page.evaluate(
    (method) =>
      (
        window as unknown as { __mockCalls?: Record<string, unknown[][]> }
      ).__mockCalls?.[method]?.length ?? 0,
    name,
  );
}

test("shows tier, balance, runway and top sources", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  const card = page.getByTestId("vitals-card");
  await expect(card.getByTestId("vitals-tier")).toHaveText("充足");
  await expect(card.getByText("$42.50", { exact: true })).toBeVisible();
  await expect(card.getByText("还能运行约 23 天", { exact: true })).toBeVisible();
  await expect(card.getByText("管家", { exact: true })).toBeVisible();
  await expect(card.getByText("任务", { exact: true })).toBeVisible();
  await expect(card.getByText("机器人", { exact: true })).toBeVisible();
});

test("explains how to start when nothing is recorded", async ({ page }) => {
  await page.goto("/test.html?fixture=vitals-unstarted");
  const card = page.getByTestId("vitals-card");
  await expect(
    card.getByText("尚未记入额度，跟管家说一声即可开始记账", { exact: true }),
  ).toBeVisible();
  await expect(card.getByText(/还能运行约/)).toHaveCount(0);
  await expect(card.getByText("近 7 天开销最多", { exact: true })).toHaveCount(0);
});

test("warns that some spend is unpriced", async ({ page }) => {
  await page.goto("/test.html?fixture=vitals-unpriced");
  await expect(
    page.getByTestId("vitals-card").getByText("部分调用无法计价，实际开销可能更高", {
      exact: true,
    }),
  ).toBeVisible();
});

test("shows a negative balance as dormant", async ({ page }) => {
  await page.goto("/test.html?fixture=vitals-dormant");
  const card = page.getByTestId("vitals-card");
  await expect(card.getByTestId("vitals-tier")).toHaveText("冬眠");
  await expect(card.getByText("-$1.20", { exact: true })).toBeVisible();
  await expect(card.getByText(/还能运行约/)).toHaveCount(0);
});

test("shows less than a day of runway", async ({ page }) => {
  await page.goto("/test.html?fixture=vitals-critical");
  const card = page.getByTestId("vitals-card");
  await expect(card.getByTestId("vitals-tier")).toHaveText("危急");
  await expect(
    card.getByText("还能运行不到 1 天", { exact: true }),
  ).toBeVisible();
  await expect(card.getByText(/还能运行约/)).toHaveCount(0);
});

test("keeps the page when vitals fail and retries", async ({ page }) => {
  await page.goto("/test.html?fixture=vitals-failed");
  const card = page.getByTestId("vitals-card");
  await expect(card.getByText("暂时读不到体征", { exact: true })).toBeVisible();
  await expect(page.getByText("各部分健康", { exact: true })).toBeVisible();

  const before = await mockCallCount(page, "lifeVitals");
  await card.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => mockCallCount(page, "lifeVitals")).toBe(before + 1);
});

test("points to Growth when the cloud is too old", async ({ page }) => {
  await page.goto("/test.html?fixture=vitals-unsupported");
  await expect(
    page.getByTestId("vitals-card").getByText("云端升级后可查看体征", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "前往成长", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "成长", exact: true }),
  ).toBeVisible();
});

test("hides the wallet card when the wallet is not configured", async ({ page }) => {
  await page.goto("/test.html?fixture=wallet-unconfigured");
  await expect(page.getByTestId("wallet-card")).toHaveCount(0);
});

test("shows the wallet card with its value", async ({ page }) => {
  await page.goto("/test.html?fixture=wallet-configured");
  const card = page.getByTestId("wallet-card");
  await expect(card).toBeVisible();
  await expect(card.getByText(/\$12\.50/)).toBeVisible();
  await expect(card.getByText("0xabab…abab", { exact: true })).toBeVisible();
  await card.click();
  await expect(
    page.getByRole("heading", { level: 1, name: "钱包", exact: true }),
  ).toBeVisible();
});

test("shows the wallet card after the wallet is configured", async ({ page }) => {
  await page.goto("/test.html?fixture=wallet-unconfigured");
  await expect(page.getByTestId("wallet-card")).toHaveCount(0);

  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "钱包", exact: true }).click();
  await page
    .getByLabel("智能体的私钥", { exact: true })
    .fill(`0x${"1".repeat(64)}`);
  await page.getByLabel("你的收款地址", { exact: true }).fill(`0x${"2".repeat(40)}`);
  await page.getByRole("button", { name: "保存并部署" }).click();
  await expect(page.getByTestId("wallet-status")).toHaveText("已配置");

  await nav.getByRole("button", { name: "生命体征", exact: true }).click();
  await expect(page.getByTestId("wallet-card")).toBeVisible();
});

test("does not poll vitals", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await expect(page.getByTestId("vitals-tier")).toBeVisible();
  expect(await mockCallCount(page, "lifeVitals")).toBe(1);
  await page.waitForTimeout(3_000);
  expect(await mockCallCount(page, "lifeVitals")).toBe(1);
});

test("english copy has no Chinese", async ({ page }) => {
  await useEnglish(page, "/test.html?fixture=configured");
  await expect(
    page.getByRole("heading", { level: 1, name: "Vitals", exact: true }),
  ).toBeVisible();
  await expectNoChinese(page, "main");
});
