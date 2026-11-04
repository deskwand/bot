import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { FALLBACK_CODE_MESSAGE, describeCode } from "../../src/services/errors";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCREENS = fileURLToPath(new URL("../../test-results/screens", import.meta.url));

// The UI must never claim verified delivery without cloud evidence. One helper so
// a copy change cannot silently drop this guard.
async function expectNoVerifiedClaim(page: Page) {
  await expect(page.getByText("收发已验证", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("verification-wechat-verified-cloud")).toHaveCount(0);
  await expect(page.getByTestId("verification-telegram-verified-cloud")).toHaveCount(0);
}

test.beforeAll(() => {
  mkdirSync(SCREENS, { recursive: true });
});

async function screenshot(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: join(SCREENS, name), fullPage });
}

// connectCloudflare drives the OAuth consent from the welcome page. The mock
// client finishes the flow on its own, so no browser round trip happens here.
async function connectCloudflare(page: Page) {
  await page.getByRole("button", { name: "使用 Cloudflare 登录" }).click();
  await expect(page.getByRole("button", { name: "部署新服务" })).toBeVisible();
}


function keyRow(page: Page, provider: string) {
  return page.getByTestId(`model-key-row-${provider}`);
}

type ConfigCalls = {
  install: {
    butlerModel?: { provider: string; id: string };
    taskModel?: { provider: string; id: string };
  }[];
  publish: { secrets?: { name: string; operation: string }[] }[];
};

async function recordedConfigCalls(page: Page): Promise<ConfigCalls | undefined> {
  return page.evaluate(
    () => (window as unknown as { __configCalls?: ConfigCalls }).__configCalls,
  );
}

async function chooseModel(page: Page, label: string, provider: string, model: RegExp) {
  const providerTrigger = page.getByLabel(`${label}供应商`);
  const switching = (await providerTrigger.textContent())?.trim() !== provider;
  await providerTrigger.click();
  await page.getByRole("option", { name: provider, exact: true }).click();
  // A newly picked provider opens its model list by itself.
  if (!switching) await page.getByLabel(label, { exact: true }).click();
  await page.getByRole("listbox").getByRole("option", { name: model }).click();
}

const WORKERS_AI_QUOTA_NOTICE =
  "使用你 Cloudflare 账号每天 10,000 neurons 的免费额度，用完后 UTC 0 点重置；超出后免费账号会暂停，付费账号按量计费。";

// New installs leave the stored role models empty, so the models page falls
// back to DEFAULT_MODEL for both roles.
async function installAndOpenModels(page: Page) {
  await page.goto("/test.html");
  await connectCloudflare(page);
  await page.getByRole("button", { name: "部署新服务" }).click();
  await page.locator("#install-channel-telegram").click();
  await page.getByRole("button", { name: "检查并部署" }).click();
  await expect(page.getByText("部署未完成")).toBeVisible();
  await page.getByTestId("result-resume").click();
  await page.getByRole("button", { name: /设置模型/ }).click();
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
}

test("production bundle contains no fixture router", () => {
  const dist = join(ROOT, "dist");
  const files = readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  const bundle = files
    .filter((file) => file.endsWith(".js") || file.endsWith(".html") || file.endsWith(".css"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  expect(bundle).not.toContain("fixture=");
  expect(bundle).not.toContain("createMockClient");
  expect(bundle).not.toContain("src/testing");
  expect(files.some((file) => file.endsWith("test.html"))).toBe(false);
});


test("describeCode covers every fixed Go error code", () => {
  const goRoot = fileURLToPath(new URL("../../../internal", import.meta.url));
  const files = readdirSync(goRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".go") && !entry.name.endsWith("_test.go"))
    .map((entry) => join(entry.parentPath, entry.name));
  const codes = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of [
      /^\s*(?:Code|ErrCode)[A-Za-z0-9_]*\s*=\s*"([A-Z][A-Z0-9_]{3,})"/gm,
      /^\s*([A-Z][A-Z0-9_]{3,})\s*=\s*"([A-Z][A-Z0-9_]{3,})"/gm,
      /Code:\s*"([A-Z][A-Z0-9_]{3,})"/g,
      /"(WECHAT_ILINK_[A-Z0-9_]+)"/g,
    ]) {
      for (const match of source.matchAll(pattern)) {
        const code = match[2] && /^[A-Z][A-Z0-9_]{3,}$/.test(match[2]) ? match[2] : match[1];
        if (code) codes.add(code);
      }
    }
  }
  expect(codes.size).toBeGreaterThan(30);
  for (const code of codes) {
    expect(describeCode(code), `missing describeCode entry for ${code}`).not.toBe(
      FALLBACK_CODE_MESSAGE,
    );
  }
  expect(describeCode("UP_TO_DATE")).not.toBe(FALLBACK_CODE_MESSAGE);
  // The copy budget is a requirement, not a one-off cleanup. The backup notice
  // is pinned verbatim by its own spec and is the only exemption.
  const pinned = new Set(["云端服务尚不支持数据备份，请先在更新页升级。"]);
  for (const code of codes) {
    const line = describeCode(code);
    if (pinned.has(line)) continue;
    expect(line.length, `${code} is longer than 22 characters`).toBeLessThanOrEqual(22);
  }
  expect(describeCode("WECHAT_ILINK_HTTP_500")).not.toBe(FALLBACK_CODE_MESSAGE);
});

test("welcome → token connect → preflight → interrupted deployment → resume → models → WeChat QR → publish", async ({ page }) => {
  await page.goto("/test.html");
  await expect(page.getByRole("heading", { name: "部署一次，随时管理。" })).toBeVisible();
  await screenshot(page, "01-welcome.png");

  await expect(
    page.getByText("浏览器里完成授权，不需要填写 token。", { exact: true }),
  ).toBeVisible();
  await connectCloudflare(page);
  await expect(page.getByLabel("API Token")).toHaveCount(0);

  await page.getByRole("button", { name: "部署新服务" }).click();
  await page.getByLabel("允许使用的 Telegram 用户 ID").fill("100000001");
  await page.locator("#install-channel-telegram").click();
  await page.getByRole("button", { name: "检查并部署" }).click();

  await expect(page.getByText("部署未完成")).toBeVisible();
  await page.getByTestId("result-resume").click();
  await expect(page.getByRole("heading", { name: "服务已部署，接下来设置消息入口" })).toBeVisible();
  await expectNoVerifiedClaim(page);

  await page.getByRole("button", { name: /设置模型/ }).click();
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
  await screenshot(page, "02-models.png");

  // New installs default to Workers AI; this flow still exercises explicit keys.
  await chooseModel(page, "管家模型", "OpenCode Go", /DeepSeek V4\.1 Flash/);
  await chooseModel(page, "任务模型", "OpenCode Go", /DeepSeek V4\.1 Flash/);
  await keyRow(page, "opencode-go").getByLabel("API 密钥").fill("sk-model-SENTINEL-value");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(/别人在控制台改过同名密钥的值/)).toBeVisible();
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();
  await expectNoVerifiedClaim(page);

  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await expect(page.getByRole("heading", { name: "消息入口", exact: true })).toBeVisible();
  await page.locator("#current-wechat").click();
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(page.getByText("发布结果")).toBeVisible();

  await page.getByRole("button", { name: "连接微信" }).click();
  const qr = page.getByTestId("wechat-qr");
  await expect(qr).toBeVisible();
  await expect(qr.getByLabel("微信登录二维码")).toBeVisible();
  await screenshot(page, "03-entries-qr.png", false);

  await expect(page.getByRole("heading", { name: "已连接", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("已连接，等待第一条消息")).toBeVisible();
  await expectNoVerifiedClaim(page);
});



test("models page defaults to Workers AI and asks for no key", async ({ page }) => {
  await installAndOpenModels(page);

  await expect(page.getByLabel("管家模型供应商")).toHaveText(/Cloudflare Workers AI/);
  await expect(page.getByLabel("任务模型供应商")).toHaveText(/Cloudflare Workers AI/);
  await expect(page.getByLabel("管家模型", { exact: true })).toHaveText(/GLM 5\.3 Flash/);
  await expect(page.getByLabel("任务模型", { exact: true })).toHaveText(/GLM 5\.3 Flash/);
  await expect(keyRow(page, "workers-ai")).toHaveCount(0);
  await expect(page.getByText(WORKERS_AI_QUOTA_NOTICE)).toBeVisible();
});

test("switching back to Workers AI drops the key row", async ({ page }) => {
  await installAndOpenModels(page);

  await chooseModel(page, "任务模型", "OpenCode Go", /DeepSeek V4\.1 Flash/);
  await expect(keyRow(page, "opencode-go")).toBeVisible();

  await chooseModel(
    page,
    "任务模型",
    "Cloudflare Workers AI（免费额度）",
    /GLM 5\.3 Flash/,
  );
  await expect(keyRow(page, "opencode-go")).toHaveCount(0);
  await expect(page.getByText(WORKERS_AI_QUOTA_NOTICE)).toBeVisible();
});

test("text-only Workers AI models are labelled", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByLabel("管家模型供应商").click();
  await page.getByRole("option", { name: "Cloudflare Workers AI（免费额度）", exact: true }).click();

  await expect(
    page.getByRole("listbox").getByRole("option", { name: /GLM 4\.7 Flash/ }),
  ).toContainText("不支持图片");
  await expect(
    page.getByRole("listbox").getByRole("option", { name: /GLM 5\.3 Flash/ }),
  ).not.toContainText("不支持图片");
});

test("install form defaults both models to Workers AI", async ({ page }) => {
  await page.goto("/test.html");
  await connectCloudflare(page);
  await page.getByRole("button", { name: "部署新服务" }).click();

  await expect(page.getByLabel("管家模型供应商")).toHaveText(/Cloudflare Workers AI/);
  await expect(page.getByLabel("任务模型供应商")).toHaveText(/Cloudflare Workers AI/);
  await expect(page.getByLabel("管家模型", { exact: true })).toHaveText(/GLM 5\.3 Flash/);
  await expect(page.getByLabel("任务模型", { exact: true })).toHaveText(/GLM 5\.3 Flash/);

  await page.locator("#install-channel-telegram").click();
  await page.getByRole("button", { name: "检查并部署" }).click();
  await expect(page.getByText("部署未完成")).toBeVisible();
  await expect(page.getByTestId("error-alert")).toHaveCount(0);

  const calls = await recordedConfigCalls(page);
  expect(calls?.install.at(-1)?.butlerModel).toEqual({
    provider: "workers-ai",
    id: "@cf/zai-org/glm-5.3-flash",
  });
  expect(calls?.install.at(-1)?.taskModel).toEqual({
    provider: "workers-ai",
    id: "@cf/zai-org/glm-5.3-flash",
  });
});

test("a stale key draft is not published after switching back", async ({ page }) => {
  await installAndOpenModels(page);

  await chooseModel(page, "任务模型", "OpenCode Go", /DeepSeek V4\.1 Flash/);
  await keyRow(page, "opencode-go")
    .getByLabel("API 密钥")
    .fill("sk-stale-SENTINEL");
  await chooseModel(
    page,
    "任务模型",
    "Cloudflare Workers AI（免费额度）",
    /GLM 5\.3 Flash/,
  );
  await expect(keyRow(page, "opencode-go")).toHaveCount(0);

  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();

  const calls = await recordedConfigCalls(page);
  expect(calls?.publish.at(-1)?.secrets ?? []).toEqual([]);
});

test("login published follow-up with a publish operation id is accepted", async ({ page }) => {
  await page.goto("/test.html?fixture=login-sync");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await page.getByRole("button", { name: "连接微信" }).click();
  await expect(page.getByTestId("wechat-qr")).toBeVisible();
  await expect(page.getByRole("heading", { name: "已连接", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("已连接，等待第一条消息")).toBeVisible();
  await expectNoVerifiedClaim(page);
});

test("login publish_failed shows the code and resumes the publish operation", async ({ page }) => {
  await page.goto("/test.html?fixture=qr-publish-failed");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await page.getByRole("button", { name: "连接微信" }).click();
  await expect(page.getByRole("heading", { name: "发布失败", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("CONFIG_CONFLICT")).toBeVisible();
  await expectNoVerifiedClaim(page);
  await alert.getByRole("button", { name: "继续" }).click();
  await expect(page.getByRole("heading", { name: "已连接", exact: true })).toBeVisible({
    timeout: 10_000,
  });
});

test("unchanged entry result explains that no version was published", async ({ page }) => {
  await page.goto("/test.html?fixture=entry-unchanged");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await page.locator("#current-wechat").click();
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(page.getByText("入口未变化。")).toBeVisible();
  await expect(page.getByText("无变化")).toBeVisible();
});

test("unknown entry selection offers a resume action", async ({ page }) => {
  await page.goto("/test.html?fixture=entry-unknown");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await page.locator("#current-wechat").click();
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(page.getByTestId("channel-resume")).toBeVisible();
  await page.getByTestId("channel-resume").click();
  await expect(page.getByText("已发布")).toBeVisible();
});

test("import preview explains legacy schema, preserved secrets and plaintext migration", async ({ page }) => {
  await page.goto("/test.html");
  await connectCloudflare(page);
  await page.getByRole("button", { name: "连接已有服务" }).click();
  await expect(page.getByText("候选 Worker")).toBeVisible();
  const legacy = page.locator("li", { hasText: "my-bot" }).first();
  await legacy.getByRole("button", { name: "检查并接管" }).click();
  await expect(page.getByText("需要兼容升级")).toBeVisible();
  await expect(page.getByText(/保持原值，客户端不读取/)).toBeVisible();
  await expect(page.getByText(/发现明文凭据/)).toBeVisible();
  await expect(page.getByText(/mcpServers\[0\]\.headers\.Authorization/)).toBeVisible();
  await page.getByRole("button", { name: "确认配置并接管" }).click();
  await expect(page.getByRole("button", { name: "进入管理首页" })).toBeVisible();
  await expect(page.getByText(/已有服务已连接/)).toBeVisible();
});



test("import resume continues an unknown takeover result", async ({ page }) => {
  await page.goto("/test.html?fixture=import-resume");
  await connectCloudflare(page);
  await page.getByRole("button", { name: "连接已有服务" }).click();
  const legacy = page.locator("li", { hasText: "my-bot" }).first();
  await legacy.getByRole("button", { name: "检查并接管" }).click();
  await page.getByRole("button", { name: "确认配置并接管" }).click();
  await expect(page.getByText("接管未完成")).toBeVisible();
  await page.getByTestId("result-resume").click();
  await expect(page.getByRole("button", { name: "进入管理首页" })).toBeVisible();
});

test("import retry requires re-entering cleared secrets", async ({ page }) => {
  await page.goto("/test.html?fixture=import-secret-retry");
  await connectCloudflare(page);
  await page.getByRole("button", { name: "连接已有服务" }).click();
  const legacy = page.locator("li", { hasText: "my-bot" }).first();
  await legacy.getByRole("button", { name: "检查并接管" }).click();
  await page.getByRole("button", { name: "确认配置并接管" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("PLAINTEXT_SECRET_DETECTED")).toBeVisible();
  await expect(page.getByRole("button", { name: "重新确认" })).toHaveCount(0);
  await expect(page.getByText(/请重填上方密钥后再试/)).toBeVisible();
  await expect(page.getByLabel("MCP_HEADER_AUTHORIZATION 的值")).toHaveValue("");
  await page.getByLabel("MCP_HEADER_AUTHORIZATION 的值").fill("mcp-secret-SENTINEL-2");
  await page.getByRole("button", { name: "确认配置并接管" }).click();
  await expect(page.getByRole("button", { name: "进入管理首页" })).toBeVisible();
});

test("UPGRADE_REQUIRED points to the updates page", async ({ page }) => {
  await page.goto("/test.html?fixture=upgrade-required");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await keyRow(page, "opencode-go").getByLabel("API 密钥").fill("sk-upgrade-SENTINEL");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("UPGRADE_REQUIRED")).toBeVisible();
  await alert.getByRole("button", { name: "前往更新页" }).click();
  await expect(page.getByRole("heading", { name: "更新", exact: true })).toBeVisible();
});

test("model catalog failure is surfaced during setup", async ({ page }) => {
  await page.goto("/test.html?fixture=catalog-unavailable");
  await connectCloudflare(page);
  await page.getByRole("button", { name: "部署新服务" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("CATALOG_UNAVAILABLE")).toBeVisible();
  await expect(alert.getByText(/无法读取模型目录/)).toBeVisible();
});

test("OPERATION_IN_PROGRESS does not re-run install and points to pending resume", async ({ page }) => {
  await page.goto("/test.html?fixture=install-conflict");
  await connectCloudflare(page);
  await page.getByRole("button", { name: "部署新服务" }).click();
  await page.locator("#install-channel-telegram").click();
  await page.getByRole("button", { name: "检查并部署" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("OPERATION_IN_PROGRESS")).toBeVisible();
  await expect(alert.getByRole("button", { name: "先用顶部的「继续」处理" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新检查并部署" })).toHaveCount(0);
});


test("a pending operation can be abandoned after confirmation", async ({ page }) => {
  await page.goto("/test.html?fixture=pending-operations");
  await expect(page.getByTestId("pending-operations")).toBeVisible();
  await page.getByRole("button", { name: "放弃", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认放弃操作" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/云端资源不受影响/)).toBeVisible();
  await dialog.getByRole("button", { name: "确认放弃" }).click();
  await expect(page.getByTestId("pending-operations")).toHaveCount(0);
});

test("unknown cloud release points to the import flow", async ({ page }) => {
  await page.goto("/test.html?fixture=version-unknown");
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await expect(page.getByText(/VERSION_UNKNOWN_REIMPORT/)).toBeVisible();
  await expect(page.getByText(/版本未知，请重新导入/)).toBeVisible();
  await page.getByRole("button", { name: "重新导入" }).click();
  await expect(page.getByRole("heading", { name: "连接已有服务", exact: true })).toBeVisible();
});

test("credential store unavailability is shown on the welcome page", async ({ page }) => {
  await page.goto("/test.html?fixture=store-unavailable");
  await expect(page.getByRole("heading", { name: "部署一次，随时管理。" })).toBeVisible();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("CREDENTIAL_STORE_UNAVAILABLE")).toBeVisible();
  await expect(page.getByRole("button", { name: "使用 Cloudflare 登录" })).toBeVisible();
});

test("a denied authorization explains itself and offers a retry", async ({ page }) => {
  await page.goto("/test.html?fixture=cf-denied");
  await page.getByRole("button", { name: "使用 Cloudflare 登录" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("AUTH_OAUTH_DENIED")).toBeVisible();
  await expect(alert.getByTestId("error-short")).toHaveText("授权已取消。");
  await expect(page.getByRole("button", { name: "使用 Cloudflare 登录" })).toBeVisible();
});

test("a finished login never falls back to the login button", async ({ page }) => {
  await page.goto("/test.html?fixture=cf-slow-apply");
  await page.getByRole("button", { name: "使用 Cloudflare 登录" }).click();
  // The status read is slow: the card must keep saying "connected", not offer
  // to log in again as if nothing happened.
  await expect(page.getByText("已连接，正在读取云端服务。")).toBeVisible();
  await expect(page.getByRole("button", { name: "使用 Cloudflare 登录" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "部署新服务" })).toBeVisible();
});

test("a login the client cannot confirm returns to a usable login card", async ({ page }) => {
  await page.goto("/test.html?fixture=cf-slow-apply-fail");
  await page.getByRole("button", { name: "使用 Cloudflare 登录" }).click();
  // The status read failed: the card must stop claiming success and give the
  // login button back instead of leaving a spinner and an error side by side.
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("CREDENTIAL_STORE_UNAVAILABLE")).toBeVisible();
  await expect(page.getByRole("button", { name: "使用 Cloudflare 登录" })).toBeVisible();
  await expect(page.getByText("已连接，正在读取云端服务。")).toHaveCount(0);
});

test("a timed-out authorization is reported as such", async ({ page }) => {
  await page.goto("/test.html?fixture=cf-timeout");
  await page.getByRole("button", { name: "使用 Cloudflare 登录" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("AUTH_OAUTH_TIMEOUT")).toBeVisible();
  await expect(alert.getByTestId("error-short")).toHaveText("授权超时，请重新登录。");
});

test("several accounts require an explicit choice", async ({ page }) => {
  await page.goto("/test.html?fixture=multi-account");
  await page.getByRole("button", { name: "使用 Cloudflare 登录" }).click();
  await expect(page.getByText("有多个账号，请选择要部署的这一个")).toBeVisible();
  await page.getByRole("radio", { name: "第二个账户" }).click();
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByRole("button", { name: "部署新服务" })).toBeVisible();
});

test("credential-store denial is explicit and never falls back to plaintext", async ({ page }) => {
  await page.goto("/test.html?fixture=credential-denied");
  await page.getByRole("button", { name: "使用 Cloudflare 登录" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("CREDENTIAL_STORE_UNAVAILABLE")).toBeVisible();
  await expect(alert.getByTestId("error-short")).toHaveText("钥匙串不可用，未改用明文保存。");
});

test("config conflict asks for a reload instead of overwriting", async ({ page }) => {
  await page.goto("/test.html?fixture=config-conflict");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
  await keyRow(page, "opencode-go").getByLabel("API 密钥").fill("sk-conflict-SENTINEL");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("CONFIG_CONFLICT")).toBeVisible();
  await expect(page.getByRole("button", { name: "重新加载配置" })).toBeVisible();
  await page.getByRole("button", { name: "重新加载配置" }).click();
  await expect(page.getByTestId("error-alert")).toHaveCount(0);
});

test("unsupported multi-version deployment blocks editing", async ({ page }) => {
  await page.goto("/test.html?fixture=multi-version");
  await expect(page.getByText("MULTI_VERSION_DEPLOYMENT").first()).toBeVisible();
  await expect(page.getByTestId("error-short")).toHaveText("多版本在接收流量，已停止覆盖。");
});


test("model connection test keeps the typed key for the next publish", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  const row = keyRow(page, "opencode-go");
  await row.getByLabel("API 密钥").fill("sk-probe-SENTINEL");
  await row.getByRole("button", { name: "测试连接" }).click();
  const dialog = page.getByRole("dialog", { name: "运行模型连接测试？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认测试" }).click();
  await expect(page.getByText(/本机探测，不代表云端收发正常/)).toBeVisible();
  await expect(row.getByLabel("API 密钥")).toHaveValue("sk-probe-SENTINEL");
});

test("secret replace and clear are distinct operations", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
  await expect(page.getByText("MODEL_KEY_OPENCODE_GO 已配置")).toBeVisible();

  const row = keyRow(page, "opencode-go");
  await row.getByLabel("API 密钥").fill("sk-replace-SENTINEL");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await expect(preview.getByText(/替换 secret MODEL_KEY_OPENCODE_GO/)).toBeVisible();
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();
  await expect(row.getByLabel("API 密钥")).toHaveValue("");

  await row.getByRole("button", { name: "清除已保存密钥" }).click();
  await page.getByRole("button", { name: "保存并发布" }).click();
  const clearPreview = page.getByRole("dialog", { name: "确认保存并发布" });
  await expect(clearPreview.getByText(/清除 secret MODEL_KEY_OPENCODE_GO/)).toBeVisible();
  await clearPreview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText("MODEL_KEY_OPENCODE_GO 未配置")).toBeVisible();
});

test("model picker chooses the provider first, then filters its models", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByLabel("管家模型供应商")).toHaveText(/OpenCode Go/);
  await expect(page.getByLabel("管家模型", { exact: true })).toHaveText(/DeepSeek V4\.1 Flash/);

  await page.getByLabel("管家模型供应商").click();
  await page.getByRole("option", { name: "Anthropic", exact: true }).click();
  // Switching provider alone does not change the saved model; the model list opens for it.
  const search = page.getByPlaceholder("搜索模型");
  await expect(search).toBeFocused();
  await expect(page.getByRole("option")).toHaveText([/Claude Sonnet 5\.5/, /Claude Haiku 5\.5/]);
  await search.fill("haiku");
  await expect(page.getByRole("option")).toHaveText([/Claude Haiku 5\.5/]);
  await search.press("Enter");
  await expect(page.getByLabel("管家模型", { exact: true })).toHaveText(/Claude Haiku 5\.5/);
  await expect(keyRow(page, "anthropic").getByText("用于管家模型")).toBeVisible();
  await expect(keyRow(page, "opencode-go").getByText("用于任务模型")).toBeVisible();

  await page.getByLabel("管家模型", { exact: true }).click();
  await page.getByPlaceholder("搜索模型").fill("no-such-model");
  await expect(page.getByText("没有匹配的模型")).toBeVisible();
});

test("model keys use MODEL_KEY_<ID> names", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await chooseModel(page, "管家模型", "DeepSeek", /^DeepSeek Flash/);
  const row = keyRow(page, "deepseek");
  await expect(row.getByText("MODEL_KEY_DEEPSEEK 未配置")).toBeVisible();
  await row.getByLabel("API 密钥").fill("sk-deepseek-SENTINEL");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await expect(preview.getByText(/替换 secret MODEL_KEY_DEEPSEEK/)).toBeVisible();
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();
  await expect(row.getByText("MODEL_KEY_DEEPSEEK 已配置")).toBeVisible();
});

test("each role provider gets its own key row", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await chooseModel(page, "管家模型", "Anthropic", /Claude Sonnet 5\.5/);
  const anthropicRow = keyRow(page, "anthropic");
  const opencodeRow = keyRow(page, "opencode-go");
  await expect(anthropicRow.getByText("MODEL_KEY_ANTHROPIC 未配置")).toBeVisible();
  await expect(opencodeRow.getByText("MODEL_KEY_OPENCODE_GO 已配置")).toBeVisible();
  await anthropicRow.getByLabel("API 密钥").fill("sk-anthropic-SENTINEL");
  await opencodeRow.getByLabel("API 密钥").fill("sk-opencode-SENTINEL");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await expect(preview.getByText(/替换 secret MODEL_KEY_ANTHROPIC/)).toBeVisible();
  await expect(preview.getByText(/替换 secret MODEL_KEY_OPENCODE_GO/)).toBeVisible();
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();
  await expect(anthropicRow.getByText("MODEL_KEY_ANTHROPIC 已配置")).toBeVisible();
  await expect(opencodeRow.getByText("MODEL_KEY_OPENCODE_GO 已配置")).toBeVisible();
});

test("custom endpoint can be added and selected", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: "添加自定义端点" }).click();
  const dialog = page.getByRole("dialog", { name: "添加自定义端点" });
  await dialog.getByLabel("端点 ID").fill("my-proxy");
  await dialog.getByLabel("显示名称").fill("我的中转");
  await dialog.getByLabel("Base URL").fill("https://proxy.example.com/v1");
  await expect(
    dialog.getByText("OpenAI 兼容通常带 /v1，Anthropic 不带"),
  ).toBeVisible();
  await dialog.getByLabel("模型 ID（用逗号分隔）").fill("gpt-5.6");
  await dialog.getByRole("button", { name: "保存端点" }).click();
  await expect(page.getByText("my-proxy").first()).toBeVisible();

  await chooseModel(page, "管家模型", "我的中转", /gpt-5\.6/);
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();
  await expect(page.getByLabel("管家模型供应商")).toHaveText(/我的中转/);
  await expect(page.getByLabel("管家模型", { exact: true })).toHaveText(/gpt-5\.6/);
  await expect(page.getByText("my-proxy").first()).toBeVisible();
  await expect(page.getByText("https://proxy.example.com/v1").first()).toBeVisible();
});

test("custom endpoint rejects a built-in id and plain http", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: "添加自定义端点" }).click();
  const dialog = page.getByRole("dialog", { name: "添加自定义端点" });
  await dialog.getByLabel("端点 ID").fill("deepseek");
  await dialog.getByLabel("Base URL").fill("https://proxy.example.com/v1");
  await dialog.getByLabel("模型 ID（用逗号分隔）").fill("gpt-5.6");
  await expect(dialog.getByRole("button", { name: "保存端点" })).toBeDisabled();
  await expect(dialog.getByText(/与内置厂商重名/)).toBeVisible();

  await dialog.getByLabel("端点 ID").fill("my-proxy");
  await dialog.getByLabel("Base URL").fill("http://proxy.example.com");
  await expect(dialog.getByRole("button", { name: "保存端点" })).toBeDisabled();
  await expect(dialog.getByText(/https:\/\//)).toBeVisible();
  await dialog.getByLabel("Base URL").fill("http://localhost:8080/v1");
  await expect(dialog.getByRole("button", { name: "保存端点" })).toBeEnabled();
});

test("model ids containing a slash round-trip", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await chooseModel(page, "管家模型", "OpenRouter", /Claude Sonnet 5\.5/);
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();
  await expect(page.getByLabel("管家模型供应商")).toHaveText(/OpenRouter/);
  await expect(page.getByLabel("管家模型", { exact: true })).toHaveText(/Claude Sonnet 5\.5/);
});

test("upgrade warns which model keys must be re-entered", async ({ page }) => {
  await page.goto("/test.html?fixture=upgrade-keys-missing");
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await expect(
    page.getByText(/升级后需在模型页重填：MODEL_KEY_OPENCODE_GO/),
  ).toBeVisible();
  await page.getByRole("button", { name: "升级云端服务" }).click();
  const dialog = page.getByRole("dialog", { name: "升级前确认" });
  await expect(dialog.getByText(/升级后需在模型页重填：/)).toBeVisible();
  await expect(dialog.getByText(/MODEL_KEY_OPENCODE_GO/)).toBeVisible();
});

test("MODEL_KEY_MISSING lists the missing secrets", async ({ page }) => {
  await page.goto("/test.html?fixture=model-key-missing");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await keyRow(page, "opencode-go").getByLabel("API 密钥").fill("sk-missing-SENTINEL");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("MODEL_KEY_MISSING")).toBeVisible();
  await expect(alert.getByTestId("error-short")).toHaveText("缺少模型密钥，请在模型页填写。");
  await alert.getByText("详情").click();
  await expect(alert.getByText(/MODEL_KEY_DEEPSEEK/)).toBeVisible();
});

test("dirty form protection warns before leaving", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await chooseModel(page, "管家模型", "OpenCode Go", /DeepSeek V4 Pro/);
  await page.getByRole("button", { name: "服务概览", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "有未保存的更改" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "继续编辑" }).click();
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
});

test("signing out returns to the Cloudflare login page", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await expect(page.getByRole("button", { name: "模型", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  const dialog = page.getByRole("dialog", { name: "退出 Cloudflare 账号？" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/云端服务照常运行/)).toBeVisible();
  await expect(dialog.getByText(/重新登录后可继续管理/)).toBeVisible();
  await dialog.getByRole("button", { name: "确认退出" }).click();
  await expect(page.getByRole("button", { name: "使用 Cloudflare 登录" })).toBeVisible();
  // The shell, its navigation and any pending operation block are gone.
  await expect(page.getByRole("button", { name: "模型", exact: true })).toHaveCount(0);
  await screenshot(page, "06-signout.png");
});

test("cancelling sign-out keeps the account connected", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "退出登录" }).click();
  const dialog = page.getByRole("dialog", { name: "退出 Cloudflare 账号？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "模型", exact: true })).toBeVisible();
});

test("signing out warns that unpublished edits are dropped", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await chooseModel(page, "管家模型", "OpenCode Go", /DeepSeek V4 Pro/);
  await page.getByRole("button", { name: "退出登录" }).click();
  const dialog = page.getByRole("dialog", { name: "退出 Cloudflare 账号？" });
  await expect(dialog.getByText(/未发布的修改会丢弃/)).toBeVisible();
  await dialog.getByRole("button", { name: "确认退出" }).click();
  await expect(page.getByRole("button", { name: "使用 Cloudflare 登录" })).toBeVisible();
});

test("a failed sign-out reports the error and stays connected", async ({ page }) => {
  await page.goto("/test.html?fixture=cf-signout-failed");
  await page.getByRole("button", { name: "退出登录" }).click();
  const dialog = page.getByRole("dialog", { name: "退出 Cloudflare 账号？" });
  const confirm = dialog.getByRole("button", { name: "确认退出" });
  await confirm.click();
  // In flight: the dialog must not offer a second click or a way out.
  await expect(confirm).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  const alert = dialog.getByTestId("error-alert");
  await expect(alert.getByText("CREDENTIAL_STORE_UNAVAILABLE")).toBeVisible();
  await expect(alert.getByTestId("error-short")).toHaveText("钥匙串不可用，未改用明文保存。");
  await expect(dialog).toBeVisible();
  await expect(confirm).toBeEnabled();
  // The client is still signed in: cancelling returns to a working shell.
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("button", { name: "模型", exact: true })).toBeVisible();
});

test("an operation from a previously connected account is not offered", async ({ page }) => {
  await page.goto("/test.html?fixture=pending-other-account");
  await expect(page.getByRole("button", { name: "模型", exact: true })).toBeVisible();
  // Resuming it would fail TARGET_MISMATCH, so the block must not appear.
  await expect(page.getByTestId("pending-operations")).toHaveCount(0);
});

test("QR expiration offers a new code and never claims success", async ({ page }) => {
  await page.goto("/test.html?fixture=qr-expired");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await page.getByRole("button", { name: "连接微信" }).click();
  await expect(page.getByRole("heading", { name: "二维码已过期", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "重新扫码" })).toBeVisible();
  await expect(page.getByText("已连接，等待第一条消息")).toHaveCount(0);
  await expectNoVerifiedClaim(page);
  await page.getByRole("button", { name: "关闭", exact: true }).first().click();
});

test("diagnostics show unknown evidence with source and time", async ({ page }) => {
  await page.goto("/test.html?fixture=diagnostics-unknown");
  await page.getByRole("button", { name: "诊断", exact: true }).click();
  await expect(page.getByRole("heading", { name: "诊断", exact: true })).toBeVisible();
  await expect(page.getByTestId("status-wechat")).toBeVisible();
  await expect(page.getByTestId("status-wechat").getByText("未知")).toBeVisible();
  await expect(page.getByTestId("status-wechat").getByText("来源：无来源")).toBeVisible();
  await expectNoVerifiedClaim(page);
  await screenshot(page, "04-diagnostics.png");
});

test("user-confirmed evidence is labelled separately from cloud verification", async ({ page }) => {
  await page.goto("/test.html?fixture=user-evidence");
  await expect(page.getByText("用户确认收发")).toBeVisible();
  await expect(page.getByText(/用户确认，非云端日志/)).toBeVisible();
  await expect(page.getByText(/来源：Cloudflare 配置/).first()).toBeVisible();
  await expect(page.getByText("运行中", { exact: true })).toHaveCount(0);
  await expect(page.getByText("服务可连接", { exact: true })).toHaveCount(0);
  await expectNoVerifiedClaim(page);
});

test("client update is installed only on request and stays separate from the cloud", async ({ page }) => {
  await page.goto("/test.html?fixture=client-update-available");
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await expect(page.getByRole("heading", { name: "更新", exact: true })).toBeVisible();
  await expect(page.getByText("客户端可更新")).toBeVisible();
  await expect(page.getByText(/当前 0\.1\.0 → 可用 0\.2\.0/)).toBeVisible();
  await expect(page.getByText("云端服务").first()).toBeVisible();
  await expect(page.getByText("升级结果")).toHaveCount(0);

  await page.getByRole("button", { name: "安装客户端更新" }).click();
  await expect(page.getByText("客户端更新已安装", { exact: true })).toBeVisible();
  await expect(page.getByText(/重启客户端后生效/)).toBeVisible();
  await expect(page.getByText("升级结果")).toHaveCount(0);
  await screenshot(page, "05-client-update.png");
});

test("client update shows the unconfigured feed state", async ({ page }) => {
  await page.goto("/test.html?fixture=client-update-unavailable");
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await expect(page.getByRole("heading", { name: "更新", exact: true })).toBeVisible();
  await expect(page.getByText("未配置更新源")).toBeVisible();
  await expect(page.getByRole("button", { name: "安装客户端更新" })).toBeDisabled();
});

test("cloud upgrade requires confirmation and reports the control-plane result", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await expect(page.getByRole("heading", { name: "更新", exact: true })).toBeVisible();
  await expect(page.getByText("有新版本")).toBeVisible();
  await expect(page.getByText("v0.1.0")).toBeVisible();
  await page.getByRole("button", { name: "升级云端服务" }).click();
  const dialog = page.getByRole("dialog", { name: "升级前确认" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认升级" }).click();
  await expect(page.getByText("升级结果")).toBeVisible();
  await expect(page.getByText("已发布").first()).toBeVisible();
});

const BACKUP_NOTICE =
  "备份已保存。文件未加密，包含记忆、对话和微信会话上下文，请妥善保管。";
const OVERWRITE_NOTICE =
  "将清空当前部署的全部业务数据并替换为备份内容；恢复前会自动保存当前数据快照；备份时正在运行的任务恢复后可能重复执行外部动作。";

type BackupCalls = {
  restore: number;
  retry: boolean[];
  choose: number;
  abandon: number;
};

async function backupCalls(page: Page): Promise<BackupCalls> {
  return page.evaluate(() => {
    const calls = (window as unknown as { __backupCalls?: BackupCalls }).__backupCalls;
    return calls ?? { restore: 0, retry: [], choose: 0, abandon: 0 };
  });
}

test("exports a backup and shows the sensitivity notice", async ({ page }) => {
  await page.goto("/test.html?fixture=backup");
  await page.getByRole("button", { name: "数据备份", exact: true }).click();
  await expect(page.getByRole("heading", { name: "数据备份", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导出到本地", exact: true }).click();
  await expect(page.getByText(BACKUP_NOTICE)).toBeVisible();
});

test("shows progress while exporting", async ({ page }) => {
  await page.goto("/test.html?fixture=backup-progress");
  await page.getByRole("button", { name: "数据备份", exact: true }).click();
  await page.getByRole("button", { name: "导出到本地", exact: true }).click();
  const progress = page.getByTestId("backup-progress");
  await expect(progress).toContainText("导出数据库");
  await expect(progress).toContainText("120");
  await expect(page.getByText(BACKUP_NOTICE)).toBeVisible();
});

test("restores only after confirming the overwrite", async ({ page }) => {
  await page.goto("/test.html?fixture=backup");
  await page.getByRole("button", { name: "数据备份", exact: true }).click();
  await page.getByRole("button", { name: "从本地恢复", exact: true }).click();
  await expect(page.getByText("恢复摘要")).toBeVisible();
  await expect(page.getByText("deskwand-backup-deskwand-bot-20261102-090000.zip")).toBeVisible();

  await page.getByRole("button", { name: "覆盖并恢复", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认覆盖恢复" });
  await expect(dialog.getByText(OVERWRITE_NOTICE)).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await backupCalls(page)).restore).toBe(0);

  await page.getByRole("button", { name: "覆盖并恢复", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认覆盖恢复", exact: true }).click();
  await expect(page.getByText("数据已恢复。")).toBeVisible();
  await expect.poll(async () => (await backupCalls(page)).restore).toBe(1);
});

test("blocks restore on a version mismatch", async ({ page }) => {
  await page.goto("/test.html?fixture=backup-version-mismatch");
  await page.getByRole("button", { name: "数据备份", exact: true }).click();
  await page.getByRole("button", { name: "从本地恢复", exact: true }).click();
  await expect(
    page.getByText(
      "备份来自版本 1.2.0，当前部署是 1.3.0。请先把云端升级或降级到 1.2.0 再恢复。",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "覆盖并恢复", exact: true })).toBeDisabled();
});

test("overview offers retry for an unfinished restore", async ({ page }) => {
  await page.goto("/test.html?fixture=backup-pending");
  await expect(page.getByText("数据恢复未完成")).toBeVisible();
  await page.getByRole("button", { name: "重试恢复", exact: true }).click();
  await expect.poll(async () => (await backupCalls(page)).retry).toEqual([false]);
  await page.getByRole("button", { name: "回到恢复前快照", exact: true }).click();
  await expect.poll(async () => (await backupCalls(page)).retry).toEqual([false, true]);
});

test("abandons an unfinished restore record only after confirmation", async ({ page }) => {
  await page.goto("/test.html?fixture=backup-pending");
  await expect(page.getByText("数据恢复未完成")).toBeVisible();
  await page.getByRole("button", { name: "放弃记录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "放弃未完成的恢复记录？" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/不恢复也不回滚云端数据/)).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(async () => (await backupCalls(page)).abandon).toBe(0);

  await page.getByRole("button", { name: "放弃记录", exact: true }).click();
  await dialog.getByRole("button", { name: "确认放弃记录", exact: true }).click();
  await expect.poll(async () => (await backupCalls(page)).abandon).toBe(1);
  await expect(page.getByText("数据恢复未完成")).toHaveCount(0);
});

test("corrupt restore record can be abandoned without breaking the overview", async ({ page }) => {
  await page.goto("/test.html?fixture=backup-pending-corrupt");

  // The other overview calls still render their own data.
  await expect(page.getByRole("heading", { name: "服务概览" })).toBeVisible();
  await expect(page.getByText("云端服务", { exact: true })).toBeVisible();
  await expect(page.getByText("状态证据", { exact: true })).toBeVisible();

  // The corrupt record offers abandonment only, with the no-rollback wording.
  await expect(page.getByText("本机恢复记录无法读取", { exact: false })).toBeVisible();
  await expect(page.getByText(/不碰云端数据/)).toBeVisible();
  await expect(page.getByRole("button", { name: "重试恢复", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "回到恢复前快照", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "放弃记录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "放弃未完成的恢复记录？" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/不恢复也不回滚云端数据/)).toBeVisible();
  await expect.poll(async () => (await backupCalls(page)).abandon).toBe(0);

  await dialog.getByRole("button", { name: "确认放弃记录", exact: true }).click();
  await expect.poll(async () => (await backupCalls(page)).abandon).toBe(1);
  await expect(page.getByText("本机恢复记录无法读取", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "服务概览" })).toBeVisible();
  await expect(page.getByText("云端服务", { exact: true })).toBeVisible();
  await expect(page.getByText("状态证据", { exact: true })).toBeVisible();

  // A generic pending-restore failure must not claim the journal is corrupt.
  await page.goto("/test.html?fixture=backup-pending-unavailable");
  await expect(page.getByText(/暂时无法检查未完成的恢复/)).toBeVisible();
  await expect(page.getByText("本机恢复记录无法读取", { exact: false })).toHaveCount(0);
});

test("snapshot failure retries by choosing the backup again", async ({ page }) => {
  await page.goto("/test.html?fixture=backup-restore-snapshot-failed");
  await page.getByRole("button", { name: "数据备份", exact: true }).click();
  await page.getByRole("button", { name: "从本地恢复", exact: true }).click();
  await page.getByRole("button", { name: "覆盖并恢复", exact: true }).click();
  await page.getByRole("dialog", { name: "确认覆盖恢复" }).getByRole("button", { name: "确认覆盖恢复", exact: true }).click();
  await expect(page.getByText("RESTORE_SNAPSHOT_FAILED")).toBeVisible();

  await page.getByRole("button", { name: "重新选择备份", exact: true }).click();
  await expect.poll(async () => (await backupCalls(page)).choose).toBe(2);
  await expect(page.getByText("恢复摘要")).toBeVisible();
});

test("midway failure retries from the journal and shows the running state", async ({ page }) => {
  await page.goto("/test.html?fixture=backup-restore-midway-failed");
  await page.getByRole("button", { name: "数据备份", exact: true }).click();
  await page.getByRole("button", { name: "从本地恢复", exact: true }).click();
  await page.getByRole("button", { name: "覆盖并恢复", exact: true }).click();
  await page.getByRole("dialog", { name: "确认覆盖恢复" }).getByRole("button", { name: "确认覆盖恢复", exact: true }).click();
  await expect(page.getByText("BACKUP_INVALID")).toBeVisible();

  await page.getByRole("button", { name: "重试未完成恢复", exact: true }).click();
  await expect.poll(async () => (await backupCalls(page)).retry).toEqual([false]);

  await page.getByRole("button", { name: "服务概览", exact: true }).click();
  await expect(page.getByText("数据恢复未完成")).toBeVisible();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
});

test("status badges: configured entry is labelled pending verification", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  // No fixture ships a configured channel secret, so make one the way a user
  // would: save a Telegram token.
  await page.getByLabel("Bot Token").fill("123:token");
  await page.getByRole("button", { name: "保存并连接" }).click();
  await expect(page.getByTestId("verification-telegram-unverified")).toHaveText("待验证收发");
  await expect(page.getByTestId("verification-telegram-verified-cloud")).toHaveCount(0);
});

test("status badges: user confirmation is labelled as user confirmation", async ({ page }) => {
  await page.goto("/test.html?fixture=user-evidence");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await expect(page.getByTestId("verification-wechat-verified-user")).toHaveText("用户确认收发");
  await expect(page.getByTestId("verification-wechat-verified-cloud")).toHaveCount(0);
});

test("error alert shows one short line, bridge text only on demand", async ({ page }) => {
  await page.goto("/test.html?fixture=config-conflict");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await keyRow(page, "opencode-go").getByLabel("API 密钥").fill("sk-conflict-SENTINEL");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert).toBeVisible();
  await expect(alert.getByTestId("error-code")).toHaveText("CONFIG_CONFLICT");
  await expect(alert.getByTestId("error-short")).toBeVisible();
  // A closed <details> keeps its children in the DOM, so it is hidden, not absent.
  await expect(alert.getByTestId("error-detail")).toBeHidden();
  await alert.getByText("详情").click();
  await expect(alert.getByTestId("error-detail")).toBeVisible();
});

test("pinned and rewritten labels render without stray quote marks", async ({ page }) => {
  await page.goto("/test.html?fixture=backup-pending");
  await screenshot(page, "07-overview-pending-restore.png");
  // Pinned by the backup spec: the heading must be the sentence itself.
  await expect(page.getByRole("heading", { name: "数据恢复未完成", exact: true })).toBeVisible();
  await expect(page.getByText('"数据恢复未完成"')).toHaveCount(0);
  // The pending-operations row's dismiss action, same defect class.
  await page.goto("/test.html?fixture=pending-operations");
  await expect(page.getByTestId("pending-operations").getByRole("button", { name: "忽略", exact: true })).toBeVisible();
  await expect(page.getByText('"忽略"')).toHaveCount(0);
});

test("a verified state without cloud evidence never claims verified delivery", async ({ page }) => {
  await page.goto("/test.html?fixture=verified-local");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await expect(page.getByTestId("verification-wechat-unverified")).toHaveText("待验证收发");
  await expectNoVerifiedClaim(page);
});

test("appearance switch stores the choice and leaves the painting to the media query", async ({
  page,
}) => {
  await page.goto("/test.html?fixture=configured");

  const group = page.getByRole("group", { name: "外观" });
  await expect(group).toBeVisible();
  const system = group.getByRole("button", { name: "跟随系统" });
  const dark = group.getByRole("button", { name: "深色" });

  await expect(system).toHaveAttribute("aria-pressed", "true");
  await expect(dark).toHaveAttribute("aria-pressed", "false");

  await dark.click();
  await expect(dark).toHaveAttribute("aria-pressed", "true");
  await expect(system).toHaveAttribute("aria-pressed", "false");

  // The packaged app paints from prefers-color-scheme, which mygo points at the
  // app's appearance. A class swap here would not survive a system change.
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await screenshot(page, "99-appearance-dark.png");

  // The navigation collapses on narrow windows; the footer must not.
  await page.setViewportSize({ width: 420, height: 800 });
  await expect(dark).toBeVisible();
  await expect(group.getByRole("button", { name: "浅色" })).toBeEnabled();
});
