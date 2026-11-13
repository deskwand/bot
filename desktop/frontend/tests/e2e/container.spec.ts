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

async function openLocalWizard(page: Page, fixture: string) {
  await page.goto(`/test.html?fixture=${fixture}`);
  await page.getByRole("button", { name: "这台 Mac" }).click();
}

const LOCAL_STEP_LABELS = [
  "写入启动脚本与开机启动项",
  "写入 .env",
  "拉取镜像",
  "注册开机启动并启动",
  "等待容器进入健康状态",
];

test("本机：只装了 Apple container 时直接进入预检", async ({ page }) => {
  await openLocalWizard(page, "local-apple");

  // One runtime needs no choice, so the wizard lands on the preflight.
  await expect(page.getByTestId("container-preflight")).toBeVisible();
  await expect(page.getByTestId("container-runtime")).toHaveCount(0);
  await expect(
    page.getByRole("radiogroup", { name: "选择容器运行时" }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid^="container-check-"]'),
  ).toHaveCount(6);

  expect(await mockCalls(page, "detectLocalRuntimes")).toHaveLength(1);
  await expect
    .poll(async () => mockCalls(page, "connectLocal"))
    .toEqual([["apple"]]);
});

test("本机：两种都装时默认选 Apple container", async ({ page }) => {
  await openLocalWizard(page, "local-both");

  await expect(page.getByTestId("container-runtime")).toContainText(
    "选择容器运行时",
  );
  const apple = page.getByRole("radio", { name: "Apple container" });
  const docker = page.getByRole("radio", { name: "Docker 兼容" });
  await expect(apple).toBeChecked();
  await expect(docker).not.toBeChecked();

  await page.getByRole("button", { name: "继续" }).click();
  await expect
    .poll(async () => mockCalls(page, "connectLocal"))
    .toEqual([["apple"]]);
  await expect(page.getByTestId("container-preflight")).toBeVisible();

  // Picking the Docker-compatible runtime is what gets connected instead.
  await openLocalWizard(page, "local-both");
  await expect(page.getByRole("radio", { name: "Docker 兼容" })).toBeVisible();
  await page.getByRole("radio", { name: "Docker 兼容" }).check();
  await page.getByRole("button", { name: "继续" }).click();
  await expect
    .poll(async () => mockCalls(page, "connectLocal"))
    .toEqual([["compose"]]);
  await expect(page.getByTestId("container-preflight")).toBeVisible();
});

test("本机：选 Docker 兼容时预检显示 Docker 的检查项", async ({ page }) => {
  await openLocalWizard(page, "local-both");

  await page.getByRole("radio", { name: "Docker 兼容" }).check();
  await page.getByRole("button", { name: "继续" }).click();
  await expect
    .poll(async () => mockCalls(page, "connectLocal"))
    .toEqual([["compose"]]);

  const preflight = page.getByTestId("container-preflight");
  await expect(preflight).toBeVisible();
  await expect(preflight).toContainText("Docker");
  await expect(preflight).toContainText("compose 插件");
  await expect(preflight).not.toContainText("Apple container");
  // Docker's five checks, not Apple's six.
  await expect(
    preflight.locator('[data-testid^="container-check-"]'),
  ).toHaveCount(5);
  await expect(page.getByTestId("container-check-service")).toHaveCount(0);
});

test("本机：都没装时给出装法并可重新检测", async ({ page }) => {
  await openLocalWizard(page, "local-none");

  const runtime = page.getByTestId("container-runtime");
  await expect(runtime).toContainText("这台 Mac 还没有容器运行时，先装一个。");
  await expect(
    page.getByRole("link", { name: "下载 Apple container" }),
  ).toHaveAttribute("href", "https://github.com/apple/container/releases");
  await expect(page.getByRole("link", { name: "OrbStack" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Docker Desktop" })).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: "选择容器运行时" }),
  ).toHaveCount(0);

  expect(await mockCalls(page, "detectLocalRuntimes")).toHaveLength(1);
  await page.getByRole("button", { name: "重新检测" }).click();
  await expect
    .poll(async () => (await mockCalls(page, "detectLocalRuntimes")).length)
    .toBe(2);
  expect(await mockCalls(page, "connectLocal")).toHaveLength(0);
});

test("本机：走完部署后进入主界面", async ({ page }) => {
  await openLocalWizard(page, "local-apple");

  const preflight = page.getByTestId("container-preflight");
  await expect(preflight).toBeVisible();
  await expect(
    preflight.locator('[data-testid^="container-check-"]'),
  ).toHaveCount(6);
  await preflight.getByRole("button", { name: "下一步" }).click();

  await expect(page.getByTestId("container-configure")).toBeVisible();
  await page.getByLabel("允许使用的 Telegram 用户 ID").fill("100000001");
  await page.getByTestId("container-model-key-opencode-go").fill("sk-test");
  await page.getByRole("button", { name: "开始部署" }).click();

  // The local install writes a launchd agent instead of a compose file, and
  // the steps arrive in that order.
  for (const [index, label] of LOCAL_STEP_LABELS.entries()) {
    await expect
      .poll(async () =>
        (
          await page.getByTestId("step-list").locator("li").allInnerTexts()
        ).findIndex((row) => row.includes(label)),
      )
      .toBe(index);
  }

  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
});

test("本机：服务器页显示这台 Mac 与运行时", async ({ page }) => {
  await page.goto("/test.html?fixture=local-target");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "服务器", exact: true }).click();

  const server = page.getByTestId("server-page");
  await expect(server).toBeVisible();
  await expect(
    server.getByRole("heading", { level: 1, name: "这台 Mac", exact: true }),
  ).toBeVisible();
  await expect(server).toContainText("运行时");
  await expect(server).toContainText("Apple container");
  await expect(server).toContainText("本机目录");
  await expect(server).toContainText("运行正常");
  // A local target has no address or user to show.
  await expect(server).not.toContainText("主机地址");
  await expect(server).not.toContainText("用户名");

  await page.getByRole("button", { name: "断开", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("断开这台 Mac？");
  await expect(dialog).toContainText(
    "机器人会停止。配置和数据保留，以后可以重新添加。",
  );
});

test("非 macOS 不显示这台 Mac", async ({ page }) => {
  await page.goto("/test.html?fixture=local-windows");
  await expect(
    page.getByRole("button", { name: "使用 Cloudflare 登录" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "运行在自己的服务器", exact: true }),
  ).toBeVisible();
  // Wait for the boot state to land before asserting the card is absent.
  await expect
    .poll(async () => (await mockCalls(page, "bootState")).length)
    .toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "这台 Mac" })).toHaveCount(0);
});
