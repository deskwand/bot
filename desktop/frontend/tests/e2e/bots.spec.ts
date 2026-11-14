import { expect, test, type Page } from "@playwright/test";

/**
 * The page is not the default route: every case clicks the sidebar entry first,
 * the way cache.spec.ts and friends reach other pages.
 */
async function openBots(page: Page, fixture: string) {
  await page.goto(`/test.html?fixture=${fixture}`);
  await page.getByRole("button", { name: "机器人", exact: true }).click();
  await expect(page.getByTestId("bots-page")).toBeVisible();
}

test("explains an empty bot list", async ({ page }) => {
  await openBots(page, "bots-empty");
  await expect(page.getByTestId("bots-empty")).toHaveText(
    "这个 bot 还没有定义任何机器人，它会按需自己创建。",
  );
  await expect(page.getByTestId("bot-row-b1")).toHaveCount(0);
});

test("lists bots with status, task, wake time and the earner mark", async ({
  page,
}) => {
  await openBots(page, "bots-three");
  await expect(page.getByTestId("bot-status-b1")).toHaveText("运行中");
  await expect(page.getByTestId("bot-status-b2")).toHaveText("已暂停");
  await expect(page.getByTestId("bot-status-b3")).toHaveText("已结束");
  await expect(page.getByTestId("bot-row-b1")).toContainText("价格哨兵");
  await expect(page.getByTestId("bot-row-b1")).toContainText("t-42");
  await expect(page.getByTestId("bot-row-b1")).toContainText("赚钱中");
  // A paused bot has no next wake time: say so, never print 1970 or a blank.
  await expect(page.getByTestId("bot-row-b2")).toContainText("不会再自动醒来");
});

test("shows failures only when a bot has them", async ({ page }) => {
  await openBots(page, "bots-three");
  await expect(page.getByTestId("bot-failures-b2")).toContainText("连续失败");
  await expect(page.getByTestId("bot-failures-b1")).toHaveCount(0);
});

test("expands a bot into its mission, documents and runs", async ({ page }) => {
  await openBots(page, "bots-three");
  await page.getByTestId("bot-row-b1").getByRole("button").first().click();
  const detail = page.getByTestId("bot-detail-b1");
  await expect(detail).toContainText("盯着 BTC 行情");
  await expect(detail).toContainText("守则");
  await expect(detail).toContainText("已检查 4 个交易对");
});

test("shows the finish reason of a finished bot", async ({ page }) => {
  await openBots(page, "bots-three");
  await page.getByTestId("bot-row-b3").getByRole("button").first().click();
  await expect(page.getByTestId("bot-detail-b3")).toContainText("主人要求结束");
});

test("marks a bot with no record and one it cannot read", async ({ page }) => {
  await openBots(page, "bots-unreadable");
  await expect(page.getByTestId("bot-status-b9")).toHaveText("无记录");
  await expect(page.getByTestId("bot-status-b8")).toHaveText("读取失败");
});

test("says where to upgrade when the deployment is too old", async ({ page }) => {
  await openBots(page, "bots-unsupported");
  await expect(page.getByTestId("bots-unsupported")).toContainText("更新");
  await expect(page.getByTestId("bots-empty")).toHaveCount(0);
});

test("says the image is too old on a container instance", async ({ page }) => {
  await openBots(page, "bots-unsupported-container");
  await expect(page.getByTestId("bots-unsupported")).toContainText("镜像");
  await expect(page.getByTestId("bots-unsupported")).not.toContainText("更新页");
});
