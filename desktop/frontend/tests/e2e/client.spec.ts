import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { FALLBACK_CODE_MESSAGE, describeCode } from "../../src/services/errors";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCREENS = fileURLToPath(new URL("../../test-results/screens", import.meta.url));
const TOKEN_SENTINEL = "cf-token-SENTINEL-do-not-leak-123456";
const ACCOUNT_ID = "a".repeat(32);

test.beforeAll(() => {
  mkdirSync(SCREENS, { recursive: true });
});

async function screenshot(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: join(SCREENS, name), fullPage });
}

async function expectTokenAbsent(page: Page) {
  const body = await page.content();
  expect(body).not.toContain(TOKEN_SENTINEL);
  const storage = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== null) out[key] = localStorage.getItem(key) ?? "";
    }
    return JSON.stringify(out);
  });
  expect(storage).not.toContain(TOKEN_SENTINEL);
  expect(storage).not.toContain("API_KEY");
  expect(storage).not.toContain("TELEGRAM_BOT_TOKEN");
}

async function chooseModel(page: Page, label: string, option: RegExp) {
  await page.getByLabel(label).click();
  await page.getByRole("option", { name: option }).click();
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
  expect(describeCode("WECHAT_ILINK_HTTP_500")).not.toBe(FALLBACK_CODE_MESSAGE);
});

test("welcome → token connect → preflight → interrupted deployment → resume → models → WeChat QR → publish", async ({ page }) => {
  await page.goto("/test.html");
  await expect(page.getByRole("heading", { name: "部署一次，随时管理。" })).toBeVisible();
  await screenshot(page, "01-welcome.png");

  await page.getByLabel("Cloudflare 账户 ID").fill(ACCOUNT_ID);
  await page.getByLabel("API Token").fill(TOKEN_SENTINEL);
  await expect(page.getByText("Workers Observability:Edit", { exact: true })).toBeVisible();
  await expect(page.getByText(/Workers Observability Write/)).toBeVisible();
  await page.getByRole("button", { name: "连接 Cloudflare" }).click();
  await expect(page.getByRole("button", { name: "部署新服务" })).toBeVisible();
  await expect(page.getByLabel("API Token")).toHaveCount(0);

  await page.getByRole("button", { name: "部署新服务" }).click();
  await page.getByLabel("允许使用的 Telegram 用户 ID").fill("100000001");
  await page.locator("#install-channel-telegram").click();
  await page.getByRole("button", { name: "检查并部署" }).click();

  await expect(page.getByText("部署需要继续处理")).toBeVisible();
  await page.getByRole("button", { name: "继续操作" }).click();
  await expect(page.getByRole("heading", { name: "服务已部署，接下来设置消息入口" })).toBeVisible();
  await expect(page.getByText("收发已验证", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /设置模型/ }).click();
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
  await screenshot(page, "02-models.png");

  await page.getByLabel("API 密钥").fill("sk-model-SENTINEL-value");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(/他人仅替换 secret 值无法被察觉/)).toBeVisible();
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();
  await expect(page.getByText("收发已验证", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await expect(page.getByRole("heading", { name: "消息入口", exact: true })).toBeVisible();
  await page.locator("#current-wechat").click();
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(page.getByText("入口选择")).toBeVisible();

  await page.getByRole("button", { name: "连接微信" }).click();
  const qr = page.getByTestId("wechat-qr");
  await expect(qr).toBeVisible();
  await expect(qr.getByLabel("微信登录二维码")).toBeVisible();
  await screenshot(page, "03-entries-qr.png", false);

  await expect(page.getByRole("heading", { name: "凭据已发布", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("凭据已发布，等待真实消息")).toBeVisible();
  await expect(page.getByText("收发已验证", { exact: true })).toHaveCount(0);
  await expectTokenAbsent(page);
});



test("login published follow-up with a publish operation id is accepted", async ({ page }) => {
  await page.goto("/test.html?fixture=login-sync");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await page.getByRole("button", { name: "连接微信" }).click();
  await expect(page.getByTestId("wechat-qr")).toBeVisible();
  await expect(page.getByRole("heading", { name: "凭据已发布", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("凭据已发布，等待真实消息")).toBeVisible();
  await expect(page.getByText("收发已验证", { exact: true })).toHaveCount(0);
});

test("login publish_failed shows the code and resumes the publish operation", async ({ page }) => {
  await page.goto("/test.html?fixture=qr-publish-failed");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await page.getByRole("button", { name: "连接微信" }).click();
  await expect(page.getByRole("heading", { name: "凭据发布失败", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("CONFIG_CONFLICT")).toBeVisible();
  await expect(page.getByText("收发已验证", { exact: true })).toHaveCount(0);
  await alert.getByRole("button", { name: "继续" }).click();
  await expect(page.getByRole("heading", { name: "凭据已发布", exact: true })).toBeVisible({
    timeout: 10_000,
  });
});

test("unchanged entry result explains that no version was published", async ({ page }) => {
  await page.goto("/test.html?fixture=entry-unchanged");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await page.locator("#current-wechat").click();
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(page.getByText("入口未变化，未发布新版本。")).toBeVisible();
  await expect(page.getByText("无变化")).toBeVisible();
});

test("unknown entry selection offers a resume action", async ({ page }) => {
  await page.goto("/test.html?fixture=entry-unknown");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await page.locator("#current-wechat").click();
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(page.getByRole("button", { name: "继续操作" })).toBeVisible();
  await page.getByRole("button", { name: "继续操作" }).click();
  await expect(page.getByText("已发布")).toBeVisible();
});

test("import preview explains legacy schema, preserved secrets and plaintext migration", async ({ page }) => {
  await page.goto("/test.html");
  await page.getByLabel("Cloudflare 账户 ID").fill(ACCOUNT_ID);
  await page.getByLabel("API Token").fill(TOKEN_SENTINEL);
  await page.getByRole("button", { name: "连接 Cloudflare" }).click();
  await page.getByRole("button", { name: "连接已有服务" }).click();
  await expect(page.getByText("候选 Worker")).toBeVisible();
  const legacy = page.locator("li", { hasText: "my-bot" }).first();
  await legacy.getByRole("button", { name: "检查并接管" }).click();
  await expect(page.getByText("需要兼容升级")).toBeVisible();
  await expect(page.getByText(/沿用已有 secret/)).toBeVisible();
  await expect(page.getByText(/发现内联凭据/)).toBeVisible();
  await expect(page.getByText(/mcpServers\[0\]\.headers\.Authorization/)).toBeVisible();
  await page.getByRole("button", { name: "确认配置并接管" }).click();
  await expect(page.getByRole("button", { name: "进入管理首页" })).toBeVisible();
  await expect(page.getByText(/已有服务已连接/)).toBeVisible();
});



test("import resume continues an unknown takeover result", async ({ page }) => {
  await page.goto("/test.html?fixture=import-resume");
  await page.getByLabel("Cloudflare 账户 ID").fill(ACCOUNT_ID);
  await page.getByLabel("API Token").fill(TOKEN_SENTINEL);
  await page.getByRole("button", { name: "连接 Cloudflare" }).click();
  await page.getByRole("button", { name: "连接已有服务" }).click();
  const legacy = page.locator("li", { hasText: "my-bot" }).first();
  await legacy.getByRole("button", { name: "检查并接管" }).click();
  await page.getByRole("button", { name: "确认配置并接管" }).click();
  await expect(page.getByText("接管需要继续处理")).toBeVisible();
  await page.getByRole("button", { name: "继续操作" }).click();
  await expect(page.getByRole("button", { name: "进入管理首页" })).toBeVisible();
});

test("import retry requires re-entering cleared secrets", async ({ page }) => {
  await page.goto("/test.html?fixture=import-secret-retry");
  await page.getByLabel("Cloudflare 账户 ID").fill(ACCOUNT_ID);
  await page.getByLabel("API Token").fill(TOKEN_SENTINEL);
  await page.getByRole("button", { name: "连接 Cloudflare" }).click();
  await page.getByRole("button", { name: "连接已有服务" }).click();
  const legacy = page.locator("li", { hasText: "my-bot" }).first();
  await legacy.getByRole("button", { name: "检查并接管" }).click();
  await page.getByRole("button", { name: "确认配置并接管" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("PLAINTEXT_SECRET_DETECTED")).toBeVisible();
  await expect(page.getByRole("button", { name: "重新确认" })).toHaveCount(0);
  await expect(page.getByText(/请重新输入上方标记的 secret 值后再重试/)).toBeVisible();
  await expect(page.getByLabel("MCP_HEADER_AUTHORIZATION 的值")).toHaveValue("");
  await page.getByLabel("MCP_HEADER_AUTHORIZATION 的值").fill("mcp-secret-SENTINEL-2");
  await page.getByRole("button", { name: "确认配置并接管" }).click();
  await expect(page.getByRole("button", { name: "进入管理首页" })).toBeVisible();
});

test("UPGRADE_REQUIRED points to the updates page", async ({ page }) => {
  await page.goto("/test.html?fixture=upgrade-required");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByLabel("API 密钥").fill("sk-upgrade-SENTINEL");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("UPGRADE_REQUIRED")).toBeVisible();
  await alert.getByRole("button", { name: "前往更新页" }).click();
  await expect(page.getByRole("heading", { name: "更新", exact: true })).toBeVisible();
});

test("OPERATION_IN_PROGRESS does not re-run install and points to pending resume", async ({ page }) => {
  await page.goto("/test.html?fixture=install-conflict");
  await page.getByLabel("Cloudflare 账户 ID").fill(ACCOUNT_ID);
  await page.getByLabel("API Token").fill(TOKEN_SENTINEL);
  await page.getByRole("button", { name: "连接 Cloudflare" }).click();
  await page.getByRole("button", { name: "部署新服务" }).click();
  await page.locator("#install-channel-telegram").click();
  await page.getByRole("button", { name: "检查并部署" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("OPERATION_IN_PROGRESS")).toBeVisible();
  await expect(alert.getByRole("button", { name: "先用顶部「继续」处理未完成操作" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新检查并部署" })).toHaveCount(0);
});


test("a pending operation can be abandoned after confirmation", async ({ page }) => {
  await page.goto("/test.html?fixture=pending-operations");
  await expect(page.getByText("有未完成的部署操作")).toBeVisible();
  await page.getByRole("button", { name: "放弃", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认放弃操作" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/不会删除已创建的 Cloudflare 资源/)).toBeVisible();
  await dialog.getByRole("button", { name: "确认放弃" }).click();
  await expect(page.getByText("有未完成的部署操作")).toHaveCount(0);
});

test("unknown cloud release points to the import flow", async ({ page }) => {
  await page.goto("/test.html?fixture=version-unknown");
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await expect(page.getByText(/VERSION_UNKNOWN_REIMPORT/)).toBeVisible();
  await expect(page.getByText(/可能用命令行部署过/)).toBeVisible();
  await page.getByRole("button", { name: "重新导入" }).click();
  await expect(page.getByRole("heading", { name: "连接已有服务", exact: true })).toBeVisible();
});

test("credential store unavailability is shown on the welcome page", async ({ page }) => {
  await page.goto("/test.html?fixture=store-unavailable");
  await expect(page.getByRole("heading", { name: "部署一次，随时管理。" })).toBeVisible();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("CREDENTIAL_STORE_UNAVAILABLE")).toBeVisible();
  await expect(page.getByLabel("Cloudflare 账户 ID")).toBeVisible();
});

test("wrong token shows a fixed code and clears the input", async ({ page }) => {
  await page.goto("/test.html?fixture=wrong-token");
  await page.getByLabel("Cloudflare 账户 ID").fill(ACCOUNT_ID);
  await page.getByLabel("API Token").fill(TOKEN_SENTINEL);
  await page.getByRole("button", { name: "连接 Cloudflare" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert).toBeVisible();
  await expect(alert.getByText("AUTH_INVALID_TOKEN")).toBeVisible();
  await expect(alert.getByText(/重新创建令牌/)).toBeVisible();
  await expect(page.getByLabel("API Token")).toHaveValue("");
  await expectTokenAbsent(page);
});

test("credential-store denial is explicit and never falls back to plaintext", async ({ page }) => {
  await page.goto("/test.html?fixture=credential-denied");
  await page.getByLabel("Cloudflare 账户 ID").fill(ACCOUNT_ID);
  await page.getByLabel("API Token").fill(TOKEN_SENTINEL);
  await page.getByRole("button", { name: "连接 Cloudflare" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("CREDENTIAL_STORE_UNAVAILABLE")).toBeVisible();
  await expect(alert.getByText("系统凭据库不可用，未保存 API token。")).toBeVisible();
  await expect(page.getByLabel("API Token")).toHaveValue("");
  await expectTokenAbsent(page);
});

test("config conflict asks for a reload instead of overwriting", async ({ page }) => {
  await page.goto("/test.html?fixture=config-conflict");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
  await page.getByLabel("API 密钥").fill("sk-conflict-SENTINEL");
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
  await expect(page.getByText(/多个版本接收流量|3 个版本/).first()).toBeVisible();
});


test("model connection test keeps the typed key for the next publish", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByLabel("API 密钥").fill("sk-probe-SENTINEL");
  await page.getByRole("button", { name: "测试连接" }).click();
  const dialog = page.getByRole("dialog", { name: "运行模型连接测试？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认测试" }).click();
  await expect(page.getByText(/本机探测，不代表云端收发正常/)).toBeVisible();
  await expect(page.getByLabel("API 密钥")).toHaveValue("sk-probe-SENTINEL");
});

test("secret replace and clear are distinct operations", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
  await expect(page.getByText("MODEL_KEY_OPENCODE_GO 已配置")).toBeVisible();

  await page.getByLabel("API 密钥").fill("sk-replace-SENTINEL");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await expect(preview.getByText(/替换 secret MODEL_KEY_OPENCODE_GO/)).toBeVisible();
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();
  await expect(page.getByLabel("API 密钥")).toHaveValue("");

  await page.getByRole("button", { name: "清除已保存密钥" }).click();
  await page.getByRole("button", { name: "保存并发布" }).click();
  const clearPreview = page.getByRole("dialog", { name: "确认保存并发布" });
  await expect(clearPreview.getByText(/清除 secret MODEL_KEY_OPENCODE_GO/)).toBeVisible();
  await clearPreview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText("MODEL_KEY_OPENCODE_GO 未配置")).toBeVisible();
});

test("model keys use MODEL_KEY_<ID> names", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByLabel("密钥所属供应商").click();
  await page.getByRole("option", { name: "DeepSeek", exact: true }).click();
  await page.getByLabel("API 密钥").fill("sk-deepseek-SENTINEL");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await expect(preview.getByText(/替换 secret MODEL_KEY_DEEPSEEK/)).toBeVisible();
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();
  await page.getByLabel("密钥所属供应商").click();
  await page.getByRole("option", { name: "DeepSeek", exact: true }).click();
  await expect(page.getByText("MODEL_KEY_DEEPSEEK 已配置")).toBeVisible();
});

test("custom endpoint can be added and selected", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: "添加自定义端点" }).click();
  const dialog = page.getByRole("dialog", { name: "添加自定义端点" });
  await dialog.getByLabel("端点 ID").fill("my-proxy");
  await dialog.getByLabel("显示名称").fill("我的中转");
  await dialog.getByLabel("Base URL").fill("https://proxy.example.com/v1");
  await dialog.getByLabel("模型 ID（用逗号分隔）").fill("gpt-5.6");
  await dialog.getByRole("button", { name: "保存端点" }).click();
  await expect(page.getByText("my-proxy").first()).toBeVisible();

  await page.getByLabel("管家模型").click();
  await page.getByRole("option", { name: /我的中转 · gpt-5\.6/ }).click();
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();
  await expect(page.getByLabel("管家模型")).toHaveText(/我的中转 · gpt-5\.6/);
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
  await page.getByLabel("管家模型").click();
  await page.getByRole("option", { name: /OpenRouter · Claude Sonnet 5\.5/ }).click();
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  await expect(page.getByText(/配置已发布/).first()).toBeVisible();
  await expect(page.getByLabel("管家模型")).toHaveText(/OpenRouter · Claude Sonnet 5\.5/);
});

test("upgrade warns which model keys must be re-entered", async ({ page }) => {
  await page.goto("/test.html?fixture=upgrade-keys-missing");
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await expect(
    page.getByText(/升级后需要在模型页重新填写这些 key：MODEL_KEY_OPENCODE_GO/),
  ).toBeVisible();
  await page.getByRole("button", { name: "升级云端服务" }).click();
  const dialog = page.getByRole("dialog", { name: "升级前确认" });
  await expect(dialog.getByText(/升级后需要在模型页重新填写这些 key：/)).toBeVisible();
  await expect(dialog.getByText(/MODEL_KEY_OPENCODE_GO/)).toBeVisible();
});

test("MODEL_KEY_MISSING lists the missing secrets", async ({ page }) => {
  await page.goto("/test.html?fixture=model-key-missing");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByLabel("API 密钥").fill("sk-missing-SENTINEL");
  await page.getByRole("button", { name: "保存并发布" }).click();
  const preview = page.getByRole("dialog", { name: "确认保存并发布" });
  await preview.getByRole("button", { name: "确认保存并发布" }).click();
  const alert = page.getByTestId("error-alert");
  await expect(alert.getByText("MODEL_KEY_MISSING")).toBeVisible();
  await expect(alert.getByText(/MODEL_KEY_DEEPSEEK/)).toBeVisible();
});

test("dirty form protection warns before leaving", async ({ page }) => {
  await page.goto("/test.html?fixture=configured");
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await chooseModel(page, "管家模型", /OpenCode Go · DeepSeek V4 Pro/);
  await page.getByRole("button", { name: "服务概览", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "有未保存的更改" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "继续编辑" }).click();
  await expect(page.getByRole("heading", { name: "模型", exact: true })).toBeVisible();
});

test("QR expiration offers a new code and never claims success", async ({ page }) => {
  await page.goto("/test.html?fixture=qr-expired");
  await page.getByRole("button", { name: "消息入口", exact: true }).click();
  await page.getByRole("button", { name: "连接微信" }).click();
  await expect(page.getByRole("heading", { name: "二维码已过期", exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "重新扫码" })).toBeVisible();
  await expect(page.getByText("凭据已发布，等待真实消息")).toHaveCount(0);
  await expect(page.getByText("收发已验证", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭", exact: true }).first().click();
});

test("diagnostics show unknown evidence with source and time", async ({ page }) => {
  await page.goto("/test.html?fixture=diagnostics-unknown");
  await page.getByRole("button", { name: "诊断", exact: true }).click();
  await expect(page.getByRole("heading", { name: "诊断", exact: true })).toBeVisible();
  await expect(page.getByTestId("status-wechat")).toBeVisible();
  await expect(page.getByTestId("status-wechat").getByText("未知")).toBeVisible();
  await expect(page.getByTestId("status-wechat").getByText("来源：无来源")).toBeVisible();
  await expect(page.getByText("收发已验证", { exact: true })).toHaveCount(0);
  await screenshot(page, "04-diagnostics.png");
});

test("user-confirmed evidence is labelled separately from cloud verification", async ({ page }) => {
  await page.goto("/test.html?fixture=user-evidence");
  await expect(page.getByText("用户确认收发")).toBeVisible();
  await expect(page.getByText(/用户确认，非云端日志/)).toBeVisible();
  await expect(page.getByText("已读取部署配置").first()).toBeVisible();
  await expect(page.getByText(/来源：Cloudflare 配置/).first()).toBeVisible();
  await expect(page.getByText("运行中", { exact: true })).toHaveCount(0);
  await expect(page.getByText("服务可连接", { exact: true })).toHaveCount(0);
  await expect(page.getByText("收发已验证", { exact: true })).toHaveCount(0);
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
