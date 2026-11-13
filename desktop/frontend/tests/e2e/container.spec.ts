import { expect, test, type Page } from "@playwright/test";

async function openHostStep(page: Page, fixture: string) {
  await page.goto(`/test.html?fixture=${fixture}`);
  await page.getByRole("button", { name: "运行在自己的服务器" }).click();
  await expect(page.getByTestId("container-host")).toBeVisible();
  await page.getByLabel("主机地址").fill("203.0.113.7");
  await page.getByLabel("用户名").fill("root");
  await page.getByLabel("密码", { exact: true }).check();
  await page.getByLabel("登录密码").fill("hunter2");
}

async function mockCalls(page: Page, name: string) {
  return page.evaluate(
    (method) =>
      (
        window as unknown as { __mockCalls?: Record<string, unknown[][]> }
      ).__mockCalls?.[method] ?? [],
    name,
  );
}

test("未登录 Cloudflare 也能走完 SSH 部署", async ({ page }) => {
  await openHostStep(page, "container");
  await page.getByRole("button", { name: "连接" }).click();

  await expect(page.getByTestId("container-fingerprint")).toBeVisible();
  await expect(page.getByTestId("container-fingerprint")).toContainText("SHA256:");
  await page.getByRole("button", { name: "信任并继续" }).click();

  await expect(page.getByTestId("container-preflight")).toBeVisible();
  await expect(page.locator('[data-testid^="container-check-"]')).toHaveCount(6);
  await page.getByRole("button", { name: "下一步" }).click();

  await expect(page.getByTestId("container-configure")).toBeVisible();
  await page.getByLabel("允许使用的 Telegram 用户 ID").fill("100000001");
  await page.getByTestId("container-model-key-opencode-go").fill("sk-test");

  await page.getByRole("button", { name: "开始部署" }).click();
  for (const label of [
    "写入 compose 文件",
    "写入 .env",
    "拉取镜像",
    "启动容器",
    "等待容器就绪",
  ]) {
    await expect(page.getByTestId("step-list").getByText(label)).toBeVisible();
  }

  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();

  const calls = (await mockCalls(page, "installContainer")) as {
    secrets?: { name?: string }[];
  }[][];
  expect(
    calls[0]?.[0]?.secrets?.some((secret) => secret.name?.startsWith("MODEL_KEY_")),
  ).toBe(true);
});

test("缺 Docker 时显示修复命令并可重新检测", async ({ page }) => {
  await openHostStep(page, "container-docker-missing");
  await page.getByRole("button", { name: "连接" }).click();

  await expect(page.getByTestId("container-preflight")).toBeVisible();
  await expect(page.getByTestId("container-preflight")).toContainText(
    "get.docker.com",
  );
  await expect(page.getByRole("button", { name: "下一步" })).toHaveCount(0);

  await page.evaluate(() =>
    (
      window as unknown as {
        __setContainerScenario?: (scenario: string) => void;
      }
    ).__setContainerScenario?.("fresh"),
  );
  await page.getByRole("button", { name: "重新检测" }).click();
  await expect(page.getByRole("button", { name: "下一步" })).toBeVisible();
});

test("已有实例时只能接管", async ({ page }) => {
  await openHostStep(page, "container-existing");
  await page.getByRole("button", { name: "连接" }).click();
  await page.getByRole("button", { name: "信任并继续" }).click();

  await expect(page.getByTestId("container-preflight")).toBeVisible();
  await expect(page.getByTestId("container-preflight")).toContainText("100000001");
  await expect(page.getByTestId("container-preflight")).toContainText("1.2.3");
  await page.getByRole("button", { name: "接管这个实例" }).click();

  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  expect(await mockCalls(page, "installContainer")).toHaveLength(0);
});

test("认证失败留在主机表单并显示原因", async ({ page }) => {
  await openHostStep(page, "container-auth-failed");
  await page.getByRole("button", { name: "连接" }).click();

  await expect(page.getByTestId("error-alert")).toContainText(
    "登录服务器失败，请检查凭据",
  );
  await expect(page.getByTestId("container-host")).toBeVisible();
});

test("容器目标启动时不要求登录 Cloudflare", async ({ page }) => {
  await page.goto("/test.html?fixture=container-ready");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "使用 Cloudflare 登录" }),
  ).toHaveCount(0);
});

test("服务器页显示状态并能恢复上一份配置", async ({ page }) => {
  await page.goto("/test.html?fixture=container-unhealthy");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "服务器", exact: true }).click();

  const server = page.getByTestId("server-page");
  await expect(server).toBeVisible();
  await expect(server).toContainText("容器未就绪");
  await page.getByRole("button", { name: "恢复上一份配置" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "恢复", exact: true }).click();

  await expect
    .poll(async () => (await mockCalls(page, "restoreContainerConfig")).length)
    .toBe(1);
  await expect(server).toContainText("运行正常");
  await expect(
    page.getByRole("button", { name: "恢复上一份配置" }),
  ).toHaveCount(0);
});

test("连不上服务器与容器没在运行是两种提示", async ({ page }) => {
  for (const [fixture, label] of [
    ["container-unreachable", "连不上服务器"],
    ["container-stopped", "容器没有在运行"],
  ] as const) {
    await page.goto(`/test.html?fixture=${fixture}`);
    const nav = page.getByRole("navigation", { name: "主导航" });
    await nav.getByRole("button", { name: "服务器", exact: true }).click();
    await expect(page.getByTestId("server-page")).toContainText(label);
  }
});

test("容器目标下暂不支持的页面显示占位", async ({ page }) => {
  await page.goto("/test.html?fixture=container-ready");
  const nav = page.getByRole("navigation", { name: "主导航" });

  for (const name of ["双手", "钱包", "交易所", "记忆存档", "成长"]) {
    await nav.getByRole("button", { name, exact: true }).click();
    await expect(page.getByTestId("unsupported")).toBeVisible();
  }

  await nav.getByRole("button", { name: "头脑", exact: true }).click();
  await expect(page.getByTestId("unsupported")).toHaveCount(0);
  await nav.getByRole("button", { name: "声音", exact: true }).click();
  await expect(page.getByTestId("unsupported")).toHaveCount(0);

  for (const method of [
    "walletStatus",
    "saveWallet",
    "mcpStatus",
    "updateMcpServer",
    "removeMcpServer",
    "testExchange",
    "syncExchange",
    "exchangeSyncStatus",
    "exportData",
    "restoreData",
    "upgrade",
    "upgradeAvailable",
  ]) {
    expect(await mockCalls(page, method)).toHaveLength(0);
  }
});

test("断开服务器后回到欢迎页", async ({ page }) => {
  await page.goto("/test.html?fixture=container-ready");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "服务器", exact: true }).click();
  await page.getByRole("button", { name: "断开", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "断开", exact: true }).click();

  await expect
    .poll(async () => (await mockCalls(page, "disconnectContainer")).length)
    .toBe(1);
  for (const name of [
    "部署新服务",
    "连接已有服务",
    "运行在自己的服务器",
  ]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
});

test("Cloudflare 目标的导航不变", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await expect(
    nav.getByRole("button", { name: "服务器", exact: true }),
  ).toHaveCount(0);
  await nav.getByRole("button", { name: "Cloudflare", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Cloudflare", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("unsupported")).toHaveCount(0);
});
