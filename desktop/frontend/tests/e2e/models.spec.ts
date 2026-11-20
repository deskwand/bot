import { expect, test, type Page } from "@playwright/test";

const CODEX = "OpenAI Codex（ChatGPT 订阅）";

async function openModels(page: Page, scenario = "configured") {
  await page.goto(`/test.html?fixture=${scenario}`);
  await page.getByRole("button", { name: "头脑", exact: true }).click();
  await expect(page.getByRole("heading", { name: "头脑", exact: true })).toBeVisible();
}

async function chooseModel(page: Page, label: string, provider: string, model: RegExp) {
  const providerTrigger = page.getByLabel(`${label}供应商`);
  const switching = (await providerTrigger.textContent())?.trim() !== provider;
  await providerTrigger.click();
  await page.getByRole("option", { name: provider, exact: true }).click();
  if (!switching) await page.getByLabel(label, { exact: true }).click();
  await page.getByRole("listbox").getByRole("option", { name: model }).click();
}

function subscriptionRow(page: Page) {
  return page.getByTestId("model-subscription-row-openai-codex");
}

test("a subscription provider offers a login card instead of a key field", async ({ page }) => {
  await openModels(page);
  await chooseModel(page, "管家模型", CODEX, /GPT-5\.6 Luna/);

  await expect(subscriptionRow(page)).toBeVisible();
  await expect(subscriptionRow(page)).toContainText("未登录");
  await expect(page.getByTestId("model-key-row-openai-codex")).toHaveCount(0);
});

test("the browser sign-in settles into signed in without a code", async ({ page }) => {
  await openModels(page);
  await chooseModel(page, "管家模型", CODEX, /GPT-5\.6 Luna/);

  await page.getByTestId("model-subscription-login").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("已在浏览器打开登录页");
  await expect(page.getByTestId("model-subscription-code")).toHaveCount(0);

  await expect(page.getByTestId("model-subscription-done")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("model-subscription-close").click();

  await expect(subscriptionRow(page)).toContainText("已登录");
  await expect(page.getByTestId("model-subscription-disconnect")).toBeVisible();
});

test("the device-code fallback shows a code", async ({ page }) => {
  await openModels(page);
  await chooseModel(page, "管家模型", CODEX, /GPT-5\.6 Luna/);

  await page.getByTestId("model-subscription-login").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.getByTestId("model-subscription-use-device").click();

  await expect(page.getByTestId("model-subscription-code")).toHaveText("ABCD-1234");
  await expect(dialog).toContainText("https://auth.openai.com/codex/device");
  await expect(page.getByTestId("model-subscription-done")).toBeVisible({ timeout: 15_000 });
});

test("signing out goes back to not signed in", async ({ page }) => {
  await openModels(page, "model-auth-connected");
  await chooseModel(page, "管家模型", CODEX, /GPT-5\.6 Luna/);
  await expect(subscriptionRow(page)).toContainText("已登录");

  await page.getByTestId("model-subscription-disconnect").click();

  await expect(subscriptionRow(page)).toContainText("未登录");
  await expect(page.getByTestId("model-subscription-login")).toBeVisible();
});

test("a deployment without the routes says to update it", async ({ page }) => {
  await openModels(page, "model-auth-unsupported");
  await chooseModel(page, "管家模型", CODEX, /GPT-5\.6 Luna/);

  await expect(subscriptionRow(page)).toContainText("这个部署还不支持订阅登录");
});

test("a failed start offers a retry instead of spinning", async ({ page }) => {
  await openModels(page, "model-auth-failed");
  await chooseModel(page, "管家模型", CODEX, /GPT-5\.6 Luna/);

  await page.getByTestId("model-subscription-login").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // A transient 502 must not be reported as "your deployment is too old".
  await expect(dialog).toContainText("订阅登录请求失败");
  await expect(dialog).not.toContainText("这个部署还不支持订阅登录");
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
  // The fallback stays one click away even when the browser start failed.
  await expect(page.getByTestId("model-subscription-use-device")).toBeVisible();
});
