import { expect, test } from "@playwright/test";

test("daily pages have one heading and working navigation", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(nav.getByRole("heading")).toHaveText(["心智", "感知与表达", "行动", "生计", "容器"]);
  for (const name of ["生命体征", "头脑", "视野", "声音", "双手", "钱包", "交易所", "体检", "记忆存档", "成长"]) {
    await nav.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
  }
  await expect(page.getByText("云端与客户端的版本更新")).toBeVisible(); // 循环最后停在“成长”页
});

test("the Cloudflare container has its own page", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "容器：Cloudflare" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Cloudflare", exact: true })).toBeVisible();
  await expect(page.getByText("运行这个生命体的账号与部署")).toBeVisible();
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(nav.getByRole("button", { name: "Cloudflare", exact: true })).toBeVisible();
});

test("leaving unsaved edits through the container link asks first", async ({ page }) => {
  await page.goto("/test.html?fixture=telegram-configured");
  await page.getByRole("button", { name: "声音", exact: true }).click();
  await page.getByRole("button", { name: "更换令牌", exact: true }).click();
  await page.getByLabel("Bot Token", { exact: true }).fill("draft-token");
  await page.getByRole("button", { name: "容器：Cloudflare" }).click();
  await expect(page.getByRole("dialog", { name: "有未保存的更改" })).toBeVisible();
});

test("error keeps the explanation visible and technical code expandable", async ({ page }) => {
  await page.goto("/test.html?fixture=store-unavailable");
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByTestId("error-short")).toBeVisible();
  await expect(alert.getByTestId("error-code")).toBeHidden();
  await alert.locator("summary").click();
  await expect(alert.getByTestId("error-code")).toHaveText("CREDENTIAL_STORE_UNAVAILABLE");
});

test("overview shows only unfinished configuration actions", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  const todo = page.getByTestId("overview-todos");
  await expect(todo.getByRole("button", { name: "连接消息入口", exact: true })).toBeVisible();
  await expect(todo.getByRole("button", { name: "配置模型", exact: true })).toHaveCount(0);
  const details = page.getByTestId("overview-status-details");
  await details.locator("summary").click();
  await expect(details.locator('[data-testid^="status-"]').first()).toBeVisible();
  await page.goto("/test.html?fixture=user-evidence");
  await expect(page.getByTestId("overview-todos")).toHaveCount(0);
  await expect(page.getByTestId("status-badge-wechat")).toHaveText("用户确认收发");
  await expect(page.getByText("收发已验证", { exact: true })).toHaveCount(0);
});

test("install excludes hidden Telegram owner draft on WeChat", async ({ page }) => {
  await page.goto("/test.html");
  await page.getByRole("button", { name: "使用 Cloudflare 登录" }).click();
  await page.getByRole("button", { name: "部署新服务", exact: true }).click();
  await page.locator("#install-channel-telegram").click();
  await page.getByLabel("允许使用的 Telegram 用户 ID").fill("100000001");
  await page.locator("#install-channel-wechat").click();
  await expect(page.getByLabel("允许使用的 Telegram 用户 ID")).toBeHidden();
  await page.locator("#install-channel-telegram").click();
  await expect(page.getByLabel("允许使用的 Telegram 用户 ID")).toHaveValue("100000001");
  await page.locator("#install-channel-wechat").click();
  await page.getByRole("button", { name: "检查并部署", exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __configCalls: { install: { telegramUserIds?: number[] }[] } }).__configCalls.install.at(-1)?.telegramUserIds
  )).toEqual([]);
});

test("empty resource name reveals the field without installing", async ({ page }) => {
  await page.goto("/test.html");
  await page.getByRole("button", { name: "使用 Cloudflare 登录" }).click();
  await page.getByRole("button", { name: "部署新服务", exact: true }).click();
  const resources = page.getByText("资源设置", { exact: true });
  await resources.click();
  await page.getByLabel("服务名称", { exact: true }).fill("");
  await resources.click();
  await page.locator("#install-channel-wechat").click();
  await page.getByRole("button", { name: "检查并部署", exact: true }).click();
  await expect(page.getByLabel("服务名称", { exact: true })).toBeFocused();
  await expect(page.locator("#resource-error")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __configCalls: { install: unknown[] } }).__configCalls.install)).toEqual([]);
});

test("configured Telegram token is editable on demand without losing drafts", async ({ page }) => {
  await page.goto("/test.html?fixture=telegram-configured");
  await page.getByRole("button", { name: "声音", exact: true }).click();
  await expect(page.getByLabel("Bot Token", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "更换令牌", exact: true }).click();
  await page.getByLabel("Bot Token", { exact: true }).fill("draft-token");
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await page.getByRole("button", { name: "更换令牌", exact: true }).click();
  await expect(page.getByLabel("Bot Token", { exact: true })).toHaveValue("draft-token");
  await page.getByRole("navigation").getByRole("button", { name: "头脑", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

for (const fixture of ["entry-unknown", "entry-failed"]) {
  test(`${fixture} keeps the last confirmed entry`, async ({ page }) => {
    await page.goto(`/test.html?fixture=${fixture}`);
    await page.getByRole("button", { name: "声音", exact: true }).click();
    await expect(page.getByTestId("current-entry")).toHaveText("Telegram");
    await page.locator("#current-wechat").click();
    await page.getByRole("button", { name: "保存并发布", exact: true }).click();
    await expect(page.getByTestId("current-entry")).toHaveText("Telegram");
    if (fixture === "entry-unknown") {
      await page.getByTestId("channel-resume").click();
      await expect(page.getByTestId("current-entry")).toHaveText("微信");
    } else {
      await expect(page.getByTestId("error-short")).toBeVisible();
    }
    await expect(page.getByText("收发已验证", { exact: true })).toHaveCount(0);
  });
}

for (const width of [390, 1280]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`layouts fit ${width}px in ${colorScheme} including expanded long content`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await page.goto("/test.html?fixture=layout-long-content");
      for (const name of ["生命体征", "头脑", "双手", "声音", "体检", "记忆存档", "成长"]) {
        const nav = page.getByRole("navigation", { name: "主导航" });
        if (!(await nav.isVisible())) await page.getByRole("button", { name: "打开导航", exact: true }).click();
        await nav.getByRole("button", { name, exact: true }).click();
        await expect(page.locator("main h1")).toHaveText(name);
        for (const summary of await page.locator("main details > summary").all()) {
          await summary.focus();
          await page.keyboard.press("Enter");
          await expect(summary.locator("..")).toHaveJSProperty("open", true);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width === 1280 && ["生命体征", "声音", "记忆存档"].includes(name)) {
          await page.screenshot({ path: `test-results/screens/slim-${name}-${colorScheme}.png`, fullPage: true });
        }
      }

      const nav = page.getByRole("navigation", { name: "主导航" });
      if (!(await nav.isVisible())) await page.getByRole("button", { name: "打开导航", exact: true }).click();
      await nav.getByRole("button", { name: "Cloudflare", exact: true }).click();
      await expect(page.getByText("long-name-".repeat(18))).toBeVisible();
    });
  }
}

for (const [fixture, label] of [["install-name-taken", "服务名称"], ["install-bucket-taken", "R2 存储桶名称"]]) {
  test(`${fixture} reveals and focuses the conflicting resource`, async ({ page }) => {
    await page.goto(`/test.html?fixture=${fixture}`);
    await page.getByRole("button", { name: "使用 Cloudflare 登录" }).click();
    await page.getByRole("button", { name: "部署新服务", exact: true }).click();
    await page.locator("#install-channel-wechat").click();
    await page.getByRole("button", { name: "检查并部署", exact: true }).click();
    await expect(page.getByTestId("error-short")).toBeVisible();
    await expect(page.getByLabel(label!, { exact: true })).toBeVisible();
    await expect(page.getByLabel(label!, { exact: true })).toBeFocused();
    await expect(page.getByLabel(label!, { exact: true })).toHaveAttribute("aria-invalid", "true");
  });
}

test("unknown error with a long URL fits a dark narrow window and keeps retry usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/test.html?fixture=unknown-long-error");
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByTestId("error-short")).toContainText(`https://example.com/${"x".repeat(220)}`);
  await expect(alert.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await alert.getByRole("button", { name: "重试", exact: true }).click();
  await expect(alert.getByTestId("error-short")).toBeVisible();
});
