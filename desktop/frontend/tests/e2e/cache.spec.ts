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

async function mockCallCount(page: import("@playwright/test").Page, name: string) {
  return page.evaluate(
    (method) =>
      (
        window as unknown as { __mockCalls?: Record<string, unknown[][]> }
      ).__mockCalls?.[method]?.length ?? 0,
    name,
  );
}

test("overview shows cached data then syncs", async ({ page }) => {
  await page.goto("/test.html?fixture=cloud-slow");
  await expect(
    page.getByRole("heading", { name: "deskwand-bot", exact: true }),
  ).toBeVisible({ timeout: 500 });
  await expect(page.getByText("5 分钟前的数据")).toBeVisible({ timeout: 500 });
  await expect(page.getByText("5 分钟前的数据")).toHaveCount(0, { timeout: 10_000 });
});

test("offline keeps cached data with banner", async ({ page }) => {
  await page.goto("/test.html?fixture=cloud-offline");
  await expect(
    page.getByRole("heading", { name: "deskwand-bot", exact: true }),
  ).toBeVisible();
  const banner = page.getByRole("status").filter({ hasText: "无法同步最新数据" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("显示的是 5 分钟前的数据");
  await expect(page.getByTestId("error-alert")).toHaveCount(0);

  await banner.getByRole("button", { name: "重试" }).click();
  await expect(banner).toBeVisible({ timeout: 10_000 });
});

test("revisiting a page does not reload", async ({ page }) => {
  await page.goto("/test.html?fixture=cloud-slow");
  await expect(page.getByText("5 分钟前的数据")).toHaveCount(0, { timeout: 10_000 });

  await page.getByRole("button", { name: "诊断", exact: true }).click();
  await expect(page.getByRole("heading", { name: "诊断", exact: true })).toBeVisible();
  await expect(page.getByText("正在同步…")).toHaveCount(0, { timeout: 10_000 });

  await page.getByRole("button", { name: "服务概览", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "deskwand-bot", exact: true }),
  ).toBeVisible({ timeout: 100 });
  await expect(page.getByText("正在加载…")).toHaveCount(0);
});

test("entry switch refetches config", async ({ page }) => {
  await page.goto("/test.html?fixture=cloud-slow");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await expect(page.getByRole("heading", { name: "消息入口", exact: true })).toBeVisible();
  await expect(page.getByText("5 分钟前的数据")).toHaveCount(0, { timeout: 10_000 });

  const before = await mockCallCount(page, "getConfig");
  await page.getByRole("radio", { name: "Telegram" }).click();
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect.poll(() => mockCallCount(page, "getConfig")).toBe(before + 1);
});

test("edit controls wait for cloud data", async ({ page }) => {
  await page.goto("/test.html?fixture=cloud-slow");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
  const publish = page.getByRole("button", { name: "保存并发布" });
  const keyInput = page
    .getByTestId("model-key-row-opencode-go")
    .getByLabel("API 密钥");
  await expect(publish).toBeDisabled({ timeout: 500 });
  await expect(keyInput).toBeDisabled({ timeout: 500 });
  await expect(keyInput).toBeEnabled({ timeout: 5_000 });

  await keyInput.fill("sk-ready-SENTINEL");
  await expect(publish).toBeEnabled();
});

test("background refresh does not clobber edits", async ({ page }) => {
  await page.goto("/test.html?fixture=cloud-updated");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(
    page.getByTestId("model-key-row-opencode-go").getByLabel("API 密钥"),
  ).toBeEnabled();

  await page.getByLabel("管家模型供应商").click();
  await page.getByRole("option", { name: "Anthropic", exact: true }).click();
  await page.getByPlaceholder("搜索模型").fill("haiku");
  await page.getByRole("option", { name: /Claude Haiku 5\.5/ }).click();
  await expect(page.getByLabel("管家模型", { exact: true })).toHaveText(/Claude Haiku 5\.5/);

  await page.getByRole("button", { name: "刷新" }).click();
  await expect(page.getByText("云端配置已更新")).toBeVisible();
  await expect(page.getByLabel("管家模型", { exact: true })).toHaveText(/Claude Haiku 5\.5/);

  await page.getByRole("button", { name: "载入最新" }).click();
  await expect(page.getByLabel("管家模型", { exact: true })).toHaveText(/DeepSeek V4 Pro/);
  await expect(page.getByText("云端配置已更新")).toHaveCount(0);
});

test("publish uses cloud fingerprint", async ({ page }) => {
  await page.goto("/test.html?fixture=cloud-slow");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  const publish = page.getByRole("button", { name: "保存并发布" });
  const keyInput = page
    .getByTestId("model-key-row-opencode-go")
    .getByLabel("API 密钥");
  await expect(keyInput).toBeEnabled({ timeout: 5_000 });

  await keyInput.fill("sk-fingerprint-SENTINEL");
  await expect(publish).toBeEnabled();
  await publish.click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await preview.getByRole("button", { name: "确认保存并发布" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __mockCalls?: Record<string, unknown[][]>;
            }
          ).__mockCalls?.publishConfig?.[0]?.[0] as { baseFingerprint?: string },
      ).then((input) => input?.baseFingerprint),
    )
    .toBe("fp-current");
});

test("mcp add refetches status", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "服务", exact: true }).click();
  await expect(page.getByRole("heading", { name: "服务", exact: true })).toBeVisible();
  const before = await mockCallCount(page, "mcpStatus");

  await page.getByRole("button", { name: "添加服务" }).click();
  const catalog = page.getByRole("dialog", { name: "添加服务" });
  await catalog.getByRole("button", { name: "添加 DeepWiki" }).click();
  const form = page.getByRole("dialog", { name: "添加 DeepWiki" });
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByTestId("mcp-card-deepwiki")).toBeVisible();

  await expect.poll(() => mockCallCount(page, "mcpStatus")).toBe(before + 1);
});

test("own publish does not show cloud updated banner", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  const keyInput = page
    .getByTestId("model-key-row-opencode-go")
    .getByLabel("API 密钥");
  const publish = page.getByRole("button", { name: "保存并发布" });
  await expect(keyInput).toBeEnabled();

  await keyInput.fill("sk-own-publish-one");
  await expect(publish).toBeEnabled();
  await publish.click();
  let preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();

  // The form stays locked until the invalidated config fetch supplies the
  // published fingerprint.
  await expect(keyInput).toBeEnabled();
  await keyInput.fill("sk-own-publish-two");
  await expect(page.getByText("云端配置已更新")).toHaveCount(0);
  await expect(publish).toBeEnabled();
  await publish.click();
  preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await preview.getByRole("button", { name: "确认保存并发布" }).click();

  await expect(page.getByTestId("error-alert")).toHaveCount(0);
  await expect.poll(() => mockCallCount(page, "publishConfig")).toBe(2);
});

test("a failed refetch after publish keeps the form locked", async ({ page }) => {
  await page.goto("/test.html?fixture=publish-refetch-fail");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  const keyInput = page
    .getByTestId("model-key-row-opencode-go")
    .getByLabel("API 密钥");
  const publish = page.getByRole("button", { name: "保存并发布" });
  await expect(keyInput).toBeEnabled();

  await keyInput.fill("sk-refetch-fail");
  await publish.click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();

  // The refetch fails, so the pre-publish fingerprint must not become the new
  // baseline: the form stays locked and the error is shown.
  await expect(page.getByText("无法连接云端服务").first()).toBeVisible();
  await expect(keyInput).toBeDisabled();
  await expect(publish).toBeDisabled();
});

test("a successful upgrade refetches config on return", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await expect(
    page.getByRole("heading", { name: "deskwand-bot", exact: true }),
  ).toBeVisible();
  const before = await mockCallCount(page, "getConfig");

  await page.getByRole("button", { name: "更新", exact: true }).click();
  await page.getByRole("button", { name: "升级云端服务" }).click();
  const dialog = page.getByRole("dialog", { name: "升级前确认" });
  await dialog.getByRole("button", { name: "确认升级" }).click();
  await expect(page.getByText("升级结果")).toBeVisible();

  await page.getByRole("button", { name: "服务概览", exact: true }).click();
  await expect.poll(() => mockCallCount(page, "getConfig")).toBeGreaterThan(before);
});
